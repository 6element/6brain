"use strict";

var quipu = require("quipu");
var parser = require("quipu/parser.js")
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

var sendResponseAndStatus = function(query, result){
   var body = {
      info: 
         {command: query, result: result}, 
      quipu: {
         state: quipu.state,
         signal: quipu.signalStrength
      }, 
      sense: null,
   };
   parser.encode(body)
      .then(function(message){
         var dest = modifiedDestination? modifiedDestination : PRIVATE.serverNumber;
         sendSMS("generic_encoded", message, dest);
      })
}

var overlordName = os.hostname();
var lastCommandArgs = undefined;
var firstInit = true;
var forServer = undefined;
var shouldTunnel = false;
var modifiedDestination = undefined;

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

quipu.on("transition", function (data){
   if (data.toState === "3G_connected" && data.fromState === "tunnelling")
      sendResponseAndStatus("closetunnel", "OK");
   if (data.toState === "initialized" && data.fromState === "tunnelling")
      sendResponseAndStatus("close3g", "OK");
   if (data.toState === "tunnelling" && data.fromState === "3G_connected")
      sendResponseAndStatus("openTunnel", "OK");
   if (data.toState === "initialized" && data.fromState === "3G_connected")
      sendResponseAndStatus("close3g", "OK");
   if (data.toState === "3G_connected" && data.fromState === "initialized") {
      sendResponseAndStatus("open3g", "OK");
      if (shouldTunnel)
         quipu.handle("openTunnel", parseInt(lastCommandArgs[1]), parseInt(lastCommandArgs[2]), lastCommandArgs[3]);
   }
});

quipu.on("tunnelError", function(msg){
   debug("tunnelError");
   quipu.handle("close3G");
   sendResponseAndStatus("opentunnel", "ERROR: " + msg);
});
   

quipu.on("smsReceived", function(sms){
   debug("SMS received: ", sms);
   // sms from an ant, transmit to server
   if (PRIVATE.antNumbers.indexOf(sms.from) >= 0) {
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
   // sms from authorized numbers, command
   else if (PRIVATE.authorizedNumbers.indexOf(sms.from) >= 0) {
      if (sms.from === PRIVATE.serverNumber) {
         forServer = true;
      } else {
         forServer = false;
      }
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
                     sendSMS("clear", " quipu: " + quipu.state, sms.from);
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

         case 2:
            // command with two parameters
            switch(commandArgs[0]) {
               case "changedestination":
                  modifiedDestination = commandArgs[1];
                  debug("changing destination to :", commandArgs[1]);
                  sendResponseAndStatus("changedestination", "OK");
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
                  setTimeout(function(){
                     sendResponseAndStatus("initdate", "OK");
                  }, 3000)
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

