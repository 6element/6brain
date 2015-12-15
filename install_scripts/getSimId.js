'use strict';

var exec = require('child_process').exec;
var path = require('path');

var SP = require('serialport');
var SerialPort = SP.SerialPort;

var privatePath = path.join(__dirname, '..', 'PRIVATE.json');

exec('cat ' + privatePath + ' | grep -e \'"sim": "unknown"\'', function (err, stdout) {
	if (err || stdout.length === 0)
		throw new Error('Cannot find an unknown field in the PRIVATE.json');
	else {

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
				console.log('SIM ID :', data.match(/ICCID: (.*)/)[1]);
				exec('cat ' + privatePath + ' | sed \'s/"sim": "unknown"/"sim": "' + data.match(/ICCID: (.*)/)[1].trim() + '"/g\' > tmp && mv tmp ' + privatePath, process.exit);
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
});

