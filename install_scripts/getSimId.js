'use strict';

var exec = require('child_process').exec;
var path = require('path');
var fs = require('fs');

var SP = require('serialport');
var SerialPort = SP.SerialPort;

var privatePath = path.join(__dirname, '..', 'PRIVATE.json');
var privateJson = require(privatePath);

if (!privateJson)
	throw new Error('Error in PRIVATE.json');
if (!privateJson.sim) {
	var serialPort = new SerialPort('/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0', {
		baudrate: 9600,
		parser: SP.parsers.readline('\r')
	});

	serialPort.on('data', function (data) {
		if (typeof data !== 'string')
			data = data.toString();

		if (data.match('ICCID') && data.match('ERROR'))
			console.log('error received from the modem');
		else if (data.match(/ICCID: (.*)/)) {
			var simId = data.match(/ICCID: (.*)/)[1];

			console.log('SIM ID :', simId);
			privateJson.sim = simId;
			fs.writeFile(privatePath, JSON.stringify(privateJson), process.exit);
		}
	});

	serialPort.on('open', function () {
		console.log('modem port opened');

		serialPort.write('AT^ICCID?\r', function (err) {
			if (err)
				console.log('error writing to the modem');
		});
	});
}
