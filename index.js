"use strict;"


var sensor = require("6sense");
var encodeForSMS = require('6sense/js/codec/encodeForSMS.js');
var quipu = require("quipu");
var schedule = require('node-schedule');
var numbers = require("./numbers.json");
var getIp =require("./src/getIp.js");

var MEASURE_PERIOD = 300; // in seconds
var WAKEUP_HOUR_UTC = 6;
var SLEEP_HOUR_UTC = 20;

// initilize modem
var devices = {
   modem: "/dev/ttyUSB0",
   sms: "/dev/ttyUSB2"
};
quipu.handle("initialize", devices);

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
   console.log("SMS received: ", sms);
   var commandArgs = sms.body.split(":");

   switch(commandArgs.length) {

      case 1:
         // command with no parameter
         var command = commandArgs[0];

         switch(command) {
            case "status":
               var response = JSON.stringify({
                  quipu_state: quipu.state,
                  6sense_state: sensor.state
               });
               quipu.handle("sendSMS", response, sms.from);
               break;

            case "ip":
               var response = JSON.stringify(getIp());
               quipu.handle("sendSMS", response, sms.from);
               break;
            }

      case 4:
         // command with four parameter
         switch(commandArgs[0]) {
              case "openTunnel":
               // prepare to listen to the fact that tunnel is open
               quipu.on("transition", function (data){
                   if (data.toState === "tunnelling"){
                     quipu.handle("sendSMS", "tunnelling", sms.from);
                   };
               });

               // open tunnel
               try {
                     quipu.handle("openTunnel", parsInt(commandArgs[1]), parsInt(commandArgs[2]), parsInt(commandArgs[3]));
                  } catch(err){
                     console.log(err);
                   }
            }

    
      default:
         console.log("Unrecognized command.")
     
   }
});

// spawning a 3G connexion and closing it after 30 seconds
quipu.handle("open3G");

setTimeout(function(){
   quipu.handle("close3G");
}, 30000)


// open a reverse ssh tunnel towards "kerrigan" (must be set in your ~/.ssh/config)
quipu.handle("openTunnel", 2222, 9632, "kerrigan");

setTimeout(function(){
   quipu.handle("closeTunnel");
}, 30000)