"use strict;"

var quipu = require("quipu");
var PRIVATE = require("./PRIVATE.json");
var request = require('request');

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
quipu.handle("initialize", devices, PRIVATE.PIN);
quipu.handle("sendSMS", "starting 6brain of " + process.env.HOSTNAME, PRIVATE.installerNumber);


// receiving SMS send it to 6element
quipu.on("smsReceived", function(sms){
   debug("SMS received: ", sms);
   
   request.post({
      url: 'https://6element.ants.builders/twilio',
      headers: {
         'Content-Type': 'application/json'
      },
      body: {
         Body: "test message",
         From: sms.from
      }
   }, function(error, response, body){
      if(error) {
         console.log(error);
      } else {
         console.log(response.statusCode, body);
      }
   });
});
