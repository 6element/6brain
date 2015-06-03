"use strict;"


var sensor = require("6sense");
var encodeForSMS = require('6sense/js/codec/encodeForSMS.js');
var quipu = require("quipu");
var numbers = require("./numbers.json");
quipu.handle("initialize", "/dev/ttyUSB0");

sensor.record(60);

sensor.on('results', function(results){
    console.log('ready to send SMS');
    console.log('results', results);

    encodeForSMS(results).then(function(sms){
        quipu.handle("sendSMS", sms, numbers.serverNumber);
    });
});