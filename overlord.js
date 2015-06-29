"use strict;"

var quipu = require("quipu");
var PRIVATE = require("./PRIVATE.json");
var request = require('request');
var os = require("os");
var getIp = require("./src/getIp.js");
var spawn = require('child_process').spawn;

var DEBUG = process.env.DEBUG ? process.env.DEBUG : false;

var debug = function() {
    if (DEBUG) {
        [].unshift.call(arguments, "[DEBUG 6brain/overlord] ");
        console.log.apply(console, arguments);
    };
}
var sendSMS = function(encoded, body, dest){
   if (encoded === "generic_encoded")
      quipu.sendSMS("2" + body, dest);
   else
      quipu.sendSMS("0" + body, dest);
}

var overlordName = os.hostname();
var firstInit = true;
// initilize modem
var devices = {
   modem: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0",
   sms: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0"
};

// initialize communication
quipu.handle("initialize", devices, PRIVATE.PIN);
quipu.on("transition", function (data){
   if (data.toState === "initialized" && firstInit){
      firstInit = false;
      sendSMS("clear", "init", PRIVATE.serverNumber);
      sendSMS("clear", "initialization of " + overlordName, PRIVATE.authorizedNumbers[0]);
   }
});

// receiving SMS send it to 6element
quipu.on("smsReceived", function(sms){
   debug("SMS received: ", sms);
   // authorized numbers, transmit to server
   if (PRIVATE.authorizedNumbers.indexOf(sms.from) >= 0) {
   
      request.post({
         rejectUnauthorized: false,
         url: 'https://6element.ants.builders/twilio',
         headers: {
            'Content-Type': 'application/json'
         },
         body: JSON.stringify({
            Body: sms.body,
            From: sms.from
         })
      }, function(error, response, body){
         if(error) {
            console.log("ERROR in overlord:", error);
         } else {
            debug(response.statusCode, body);
         }
      });
   }
   // server number if for debug
   else if (sms.from === PRIVATE.serverNumber) {
      var commandArgs = sms.body.trim().toLowerCase().split(":");
      debug("commandArgs ", commandArgs);

      switch(commandArgs.length) {

         case 1:
            // command with no parameter
            var command = commandArgs[0];

            switch(command) {
               case "status":
                  if (forServer)
                     sendResponseAndStatus(command, "OK");
                  else
                     sendSMS("clear", " quipu: " + quipu.state , sms.from);
                  break;
               case "reboot":
                  spawn("reboot");
                  break;
               case "ip":
                  var ips = getIp();
                  var response = Object.keys(ips).map(function(k){return k+" : "+ips[k]}).join("  ");
                  sendSMS("clear", response, sms.from);
                  break;
               case "open3g":
                  quipu.handle("open3G");
                  break;
               case "close3g":
                  shouldTunnel = false;
                  quipu.handle("close3G");
                  break;
               case "closetunnel":
                  shouldTunnel = false;
                  quipu.handle("close3G");
                  break;
               }
            break;

         case 4:
            // command with four parameters
            switch(commandArgs[0]) {
               case "date":
                  var date = commandArgs[1].replace("t", " ") + ":" + commandArgs[2] + ":" + commandArgs[3].split(".")[0];
                  debug("Received date", sms.body, date);
                  spawn("timedatectl", ["set-time", date]);
                  break;
               case "opentunnel":
                  shouldTunnel = true;
                  lastCommandArgs = commandArgs;
                  quipu.handle("open3G");
                  break;
            }
            break;
       
         default:
            console.log("Unrecognized command.", commandArgs)
        
      }
   } else {
      console.log("Unauthorized number.");
   }
});
