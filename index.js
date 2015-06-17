"use strict;"


var sensor = require("6sense");
var encodeForSMS = require('6sense/src/codec/encodeForSMS.js');
var quipu = require("quipu");
var schedule = require('node-schedule');
var numbers = require("./numbers.json");

var myPIN = require('./myPINcode.js');

var getIp = require("./src/getIp.js");
var spawn = require('child_process').spawn;

var MEASURE_PERIOD = 300; // in seconds
var WAKEUP_HOUR_UTC = 6;
var SLEEP_HOUR_UTC = 20;
var DEBUG = process.env.DEBUG ? process.env.DEBUG : false;

var debug = function() {
    if (DEBUG) {
        console.log("DEBUG from 6brain:");
        console.log.apply(console, arguments);
        console.log("==================");
    };
}

// initilize modem
var devices = {
   modem: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0",
   sms: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0"
};
quipu.handle("initialize", devices, myPIN);

// check if current time is valid and record consequently
var date = new Date();
var current_hour = date.getHours();
if (current_hour <= SLEEP_HOUR_UTC && current_hour >= WAKEUP_HOUR_UTC)
   sensor.record(MEASURE_PERIOD);

// each time a measurment is finished encode it and send it via sms
sensor.on('processed', function(results){
   encodeForSMS([results]).then(function(sms){
      quipu.handle("sendSMS", sms, numbers.serverNumber);
   });
});

// stop measurments at SLEEP_HOUR_UTC
schedule.scheduleJob('00 20 * * *', function(){
   console.log("Pausing measurments.");
   sensor.pause();
});

// restart measurments at WAKEUP_HOUR_UTC
schedule.scheduleJob('00 06 * * *', function(){
   console.log("Restarting measurments.");
   sensor.record(MEASURE_PERIOD);
});

// receiving SMS, parse to make action
quipu.on("smsReceived", function(sms){
   debug("SMS received: ", sms);
   var commandArgs = sms.body.trim().toLowerCase().split(":");
   debug("commandArgs ", commandArgs);

   switch(commandArgs.length) {

      case 1:
         // command with no parameter
         var command = commandArgs[0];

         switch(command) {
            case "status":
               var response = "quipu_state: "+ quipu.state + " 6sense_state: "+ sensor.state + " signal: " + quipu.signalStrength + " registration: " + quipu.registrationStatus;
               quipu.handle("sendSMS", response, sms.from);
               break;
            case "reboot":
               spawn("reboot");
               break;
            case "ip":
               var ips = getIp();
               var response = Object.keys(ips).map(function(k){return k+" : "+ips[k]}).join("  ");
               quipu.handle("sendSMS", response, sms.from);
               break;
            case "open3g":
               quipu.on("transition", function (data){
                  if (data.toState === "3G_connected" && data.fromState === "initialized")
                     quipu.handle("sendSMS", "3G_connected", sms.from);
               });
               quipu.handle("open3G");
               break;
            case "close3g":
               quipu.handle("close3G");
               quipu.handle("sendSMS", "3G_disconnected", sms.from);
               break;
            case "closetunnel":
               quipu.handle("close3G");
               quipu.handle("sendSMS", "stopTunneling", sms.from);
               break;
            }
         break;

      case 4:
         // command with four parameter
         switch(commandArgs[0]) {
            case "opentunnel":
               // prepare to listen to the fact that 3G is open
               quipu.on("transition", function (data){
                   if (data.toState === "3G_connected" && data.fromState === "initialized"){
                     console.log("opening tunnnel");
                     quipu.handle("sendSMS", "3G_connected", sms.from);
                     quipu.handle("openTunnel", parseInt(commandArgs[1]), parseInt(commandArgs[2]), commandArgs[3]);
                   }
                   else if (data.toState === "tunnelling"){
                     debug("sending tunnelling");
                     quipu.handle("sendSMS", "tunnelling", sms.from);
                   };
               });
               quipu.on("tunnelError", function(msg){
                  debug("tunnelError");
                  quipu.handle("close3G");
                  quipu.handle("sendSMS", "closing 3G because error in tunneling: " + msg, sms.from);
               });
               // open 3G
               try {
                  quipu.handle("open3G");
               } catch(err){
                  console.log(err);
               }
               break;
         }
         break;
    
      default:
         console.log("Unrecognized command.", commandArgs)
     
   }
});
