"use strict;"


var sensor = require("6sense");
var encodeForSMS = require('6sense/src/codec/encodeForSMS.js');
var quipu = require("quipu");
var parser = require("quipu/parser.js")
var schedule = require('node-schedule');
var PRIVATE = require("./PRIVATE.json");

var getIp = require("./src/getIp.js");
var spawn = require('child_process').spawn;
var os = require("os");

var MEASURE_PERIOD = 300; // in seconds
var WAKEUP_HOUR_UTC = "07";
var SLEEP_HOUR_UTC = "16";
var DEBUG = process.env.DEBUG ? process.env.DEBUG : false;

var devices = {
   modem: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0",
   sms: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0"
};

var antName = os.hostname();
var lastCommandArgs = undefined;
var forServer = undefined;
var firstInit = true;
var shouldTunnel = false;
var modifiedDestination = undefined;

var debug = function() {
    if (DEBUG) {
        [].unshift.call(arguments, "[DEBUG 6brain/ant] ");
        console.log.apply(console, arguments);
    };
}
var sendSMS = function(encoded, body, dest){
   if (encoded === "6sense_encoded")
      quipu.sendSMS("1" + body, dest);
   else if (encoded === "generic_encoded")
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
      sense: sensor.state,
   };
   parser.encode(body)
      .then(function(message){
         var dest = modifiedDestination? modifiedDestination : PRIVATE.serverNumber;
         sendSMS("generic_encoded", message, dest);
      })
}
// initialize communication
quipu.handle("initialize", devices, PRIVATE.PIN);
quipu.on("transition", function (data){
   if (data.toState === "initialized" && firstInit){
      firstInit = false;
      sendSMS("clear", "init", PRIVATE.serverNumber);
      sendSMS("clear", "initialization of " + antName, PRIVATE.authorizedNumbers[0]);
   }
});


// each time a measurment is finished encode it and send it via sms
sensor.on('processed', function(results){
   encodeForSMS([results]).then(function(sms){
      var dest = modifiedDestination? modifiedDestination : PRIVATE.serverNumber;
      sendSMS("6sense_encoded", sms, dest);
   });
});

// stop measurments at SLEEP_HOUR_UTC
schedule.scheduleJob('00 '+SLEEP_HOUR_UTC+' * * *', function(){
   console.log("Pausing measurments.");
   sensor.pause();
});

// restart measurments at WAKEUP_HOUR_UTC
schedule.scheduleJob('00 '+ WAKEUP_HOUR_UTC +' * * *', function(){
   console.log("Restarting measurments.");
   sensor.record(MEASURE_PERIOD);
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

sensor.on("transition", function (data){
      sendResponseAndStatus(null, null);
});

quipu.on("tunnelError", function(msg){
   debug("tunnelError");
   quipu.handle("close3G");
   sendResponseAndStatus("opentunnel", "ERROR: " + msg);
});

// receiving SMS, parse to make action
quipu.on("smsReceived", function(sms){
   debug("SMS received: ", sms);
   var commandArgs = sms.body.trim().toLowerCase().split(":");
   if (PRIVATE.authorizedNumbers.indexOf(sms.from) >= 0) {
      if (sms.from === PRIVATE.serverNumber) {
         forServer = true;
      } else {
         forServer = false;
      }
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
                     sendSMS("clear", " quipu: " + quipu.state + " 6sense: "+ sensor.state, sms.from);
                  break;
               case "reboot":
                  spawn("reboot");
                  break;
               case "ip":
                  var ips = getIp();
                  var response = Object.keys(ips).map(function(k){return k+" : "+ips[k]}).join("  ");
                  sendSMS("clear", response, sms.from);
                  break;
               case "resumerecord":
                  sensor.record(MEASURE_PERIOD);
                  sendResponseAndStatus(command, "OK");
                  break;
               case "pauserecord":
                  sensor.pause();
                  sendResponseAndStatus(command, "OK");
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
               case "changeperiod":
                  if (commandArgs[1] == parseInt(commandArgs[1], 10)){
                     MEASURE_PERIOD = parseInt(commandArgs[1], 10);
                     sensor.pause();
                     setTimeout(function(){
                        sensor.record(MEASURE_PERIOD);
                        sendResponseAndStatus("changeperiod", "OK");
                     }, 3000)
                  } else {
                     console.log("Period is not an integer ", commandArgs[1])
                  }
                  break;
               case "changestarttime":
                     WAKEUP_HOUR_UTC = commandArgs[1];
                     sendResponseAndStatus("changestarttime", "OK");
                  break;
               case "changestoptime":
                     SLEEP_HOUR_UTC = commandArgs[1];
                     sendResponseAndStatus("changestoptime", "OK");
                  break;
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
                  // check if current time is valid and record consequently
                  var current_hour = new Date().getHours();
                  if (current_hour <= SLEEP_HOUR_UTC && current_hour >= WAKEUP_HOUR_UTC)
                     sensor.record(MEASURE_PERIOD);
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
