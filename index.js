"use strict;"


var sensor = require("6sense");
var encodeForSMS = require('6sense/js/codec/encodeForSMS.js');
var quipu = require("quipu");
var schedule = require('node-schedule');
var numbers = require("./numbers.json");
var devices = {
	modem: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0",
	sms: "/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0"
};

var myPIN = require('./myPINcode.js');

quipu.handle("initialize", devices, myPINcode);

quipu.on("smsReceived", function(sms){
	console.log(sms);
});

sensor.record(300);

sensor.on('processed', function(results){
    console.log('ready to send SMS');
    console.log('results', results);

    encodeForSMS([results]).then(function(sms){
        quipu.handle("sendSMS", sms, numbers.serverNumber);
    });
});

// stop measurments at 10pm so 8pm utc
schedule.scheduleJob('00 20 * * *', function(){
	console.log("Pausing measurments.");
	sensor.pause();
});


// restart measurments at 8am so 6am utc
schedule.scheduleJob('00 06 * * *', function(){
	console.log("Restarting measurments.");
	sensor.record(300);
});