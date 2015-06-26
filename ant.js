"use strict;"


var sensor = require("6sense");
var encodeForSMS = require('6sense/src/codec/encodeForSMS.js');
var quipu = require("quipu");
var schedule = require('node-schedule');
var PRIVATE = require("./PRIVATE.json");

var getIp = require("./src/getIp.js");
var spawn = require('child_process').spawn;
var os = require("os");

var MEASURE_PERIOD = 300; // in seconds
var WAKEUP_HOUR_UTC = "07";
var SLEEP_HOUR_UTC = "18";
var DEBUG = process.env.DEBUG ? process.env.DEBUG : false;

var devices = {
   modem: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0",
   sms: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0"
};

var antName = os.hostname();
var lastSender = undefined;
var lastCommandArgs = undefined;
var firstInit = true;
var shouldTunnel = false;

var debug = function() {
    if (DEBUG) {
        [].unshift.call(arguments, "[DEBUG 6brain] ");
        console.log.apply(console, arguments);
    };
}
var sendSMS = function(encoded, body, dest){
   if (encoded === "encoded")
      quipu.sendSMS("1" + body, dest);
   else
      quipu.sendSMS("0" + body, dest);
}
// initialize communication
quipu.handle("initialize", devices, PRIVATE.PIN);
quipu.on("transition", function (data){
   if (data.toState === "initialized" && firstInit){
      firstInit = false;
      sendSMS("clear", "init", PRIVATE.serverNumber);
      sendSMS("clear", "initialization of " + antName, PRIVATE.installerNumber);
   }
});


// each time a measurment is finished encode it and send it via sms
sensor.on('processed', function(results){
   encodeForSMS([results]).then(function(sms){
      sendSMS("encoded", sms, PRIVATE.serverNumber);
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
      sendSMS("clear", "closedTunnel", lastSender);
   if (data.toState === "initialized" && data.fromState === "tunnelling")
      sendSMS("clear", "closedTunnel and 3G", lastSender);
   if (data.toState === "tunnelling" && data.fromState === "3G_connected")
      sendSMS("clear", "openedTunnel", lastSender);
   if (data.toState === "initialized" && data.fromState === "3G_connected")
      sendSMS("clear", "3G_disconnected", lastSender);
   if (data.toState === "3G_connected" && data.fromState === "initialized") {
      sendSMS("clear", "3G_connected", lastSender);
      if (shouldTunnel)
         quipu.handle("openTunnel", parseInt(lastCommandArgs[1]), parseInt(lastCommandArgs[2]), lastCommandArgs[3]);
   }
});

quipu.on("tunnelError", function(msg){
   debug("tunnelError");
   quipu.handle("close3G");
   sendSMS("clear", "closing 3G because error in tunneling: " + msg, lastSender);
});

// receiving SMS, parse to make action
quipu.on("smsReceived", function(sms){
   debug("SMS received: ", sms);
   var commandArgs = sms.body.trim().toLowerCase().split(":");
   lastSender = sms.from;
   debug("commandArgs ", commandArgs);

   switch(commandArgs.length) {

      case 1:
         // command with no parameter
         var command = commandArgs[0];

         switch(command) {
            case "status":
               var response = "quipu:"+ quipu.state + " sense:"+ sensor.state + " signal:" + quipu.signalStrength;
               sendSMS("clear", response, sms.from);
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
               break;
            case "pauserecord":
               sensor.pause();
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
                  }, 3000)
               } else {
                  console.log("Period is not an integer ", commandArgs[1])
               }
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
               console.log("current_hour ", current_hour)
               if (current_hour <= SLEEP_HOUR_UTC && current_hour >= WAKEUP_HOUR_UTC)
                  sensor.record(MEASURE_PERIOD);
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
});
