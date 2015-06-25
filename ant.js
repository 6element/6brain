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
var SLEEP_HOUR_UTC = "16";
var DEBUG = process.env.DEBUG ? process.env.DEBUG : false;

var devices = {
   modem: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0",
   sms: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0"
};

var antName = os.hostname();

var debug = function() {
   if (DEBUG) {
      console.log("DEBUG from 6brain:");
      console.log.apply(console, arguments);
      console.log("==================");
   };
}
var sendSMS = function(encoded, body, dest){
   if (encoded === "encoded")
      quipu.handle("sendSMS", "1" + body, dest);
   else
      quipu.handle("sendSMS", "0" + body, dest);
}
// initialize communication
quipu.handle("initialize", devices, PRIVATE.PIN);
quipu.on("transition", function (data){
   if (data.toState === "initialized"){
      sendSMS("clear", "init", PRIVATE.serverNumber);
      sendSMS("clear", "initialization of " + antName, PRIVATE.installerNumber);
   }
});

// check if current time is valid and record consequently
var current_hour = new Date().getHours();
if (current_hour <= SLEEP_HOUR_UTC && current_hour >= WAKEUP_HOUR_UTC)
   sensor.record(MEASURE_PERIOD);

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
            case "resumeRecord":
               sensor.record(MEASURE_PERIOD);
               break;
            case "pauseRecord":
               sensor.pause();
               break;
            case "open3g":
               quipu.on("transition", function (data){
                  if (data.toState === "3G_connected" && data.fromState === "initialized")
                     sendSMS("clear", "3G_connected", sms.from);
               });
               quipu.handle("open3G");
               break;
            case "close3g":
               quipu.handle("close3G");
               sendSMS("clear", "3G_disconnected", sms.from);
               break;
            case "closetunnel":
               quipu.handle("close3G");
               sendSMS("clear", "stopTunneling", sms.from);
               break;
            }
         break;



      case 4:
         // command with four parameter
         switch(commandArgs[0]) {
            case "date":
               var date = commandArgs[1].replace("t", " ") + ":" + commandArgs[2] + ":" + commandArgs[3].split(".")[0];
               debug("Received date", sms.body, date);
               spawn("timedatectl", ["set-time", date]);
               break;
            case "opentunnel":
               // prepare to listen to the fact that 3G is open
               quipu.on("transition", function (data){
                   if (data.toState === "3G_connected" && data.fromState === "initialized"){
                     console.log("opening tunnnel");
                     sendSMS("clear", "3G_connected", sms.from);
                     quipu.handle("openTunnel", parseInt(commandArgs[1]), parseInt(commandArgs[2]), commandArgs[3]);
                   }
                   else if (data.toState === "tunnelling"){
                     debug("sending tunnelling");
                     sendSMS("clear", "tunnelling", sms.from);
                   };
               });
               quipu.on("tunnelError", function(msg){
                  debug("tunnelError");
                  quipu.handle("close3G");
                  sendSMS("clear", "closing 3G because error in tunneling: " + msg, sms.from);
               });
               // open 3G
               try {
                  quipu.handle("open3G");
               } catch(err){
                  console.log(err);
               }
               setTimeout(function(){
                  debug("Couldn't open connection");
                  sendSMS("clear", "Timeout to open 3G.");
               }, 20000)
               break;
         }
         break;
    
      default:
         console.log("Unrecognized command.", commandArgs)
     
   }
});
