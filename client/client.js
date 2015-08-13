"use strict";

/*
**	This is the client used for 6element (it needs quipu and 6sense)
*/

var spawn = require('child_process').spawn;
var os = require('os');
var schedule = require('node-schedule');

var PRIVATE = require('./PRIVATE.json');

// Quipu : Handle communication with the modem (internet connection and sms)
var quipu = require('quipu');
var PIN = PRIVATE.PIN;

var devices = {
	modem: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0',
	sms: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0'
};

// TCP : send data through a TCP connection
var tcpClient = require('./clientModule.js');
var connectInfo = PRIVATE.connectInfo;

// 6sense : Handle the wifi-sensor
var sensor = require('6sense');

// Codecs : encode/compress datas
var sixSenseCodec = require('6sense/src/codec/encodeForSMS.js')
var genericCodec = require('quipu/parser.js');

var getIp = require('./getIp.js');

var MEASURE_PERIOD = 300; // in seconds
var WAKEUP_HOUR_UTC = '07';
var SLEEP_HOUR_UTC = '16';

var smsServer = connectInfo.smsServer ?
   connectInfo.smsServer : '';
var authorizedNumbers = connectInfo.authorizedNumbers ?
   connectInfo.authorizedNumbers : [];
var smsMonitoring = connectInfo.smsMonitoring ?
   connectInfo.smsMonitoring : false;

var tunnelInfo = {shouldTunnel: false, arg1: undefined, arg2: undefined, arg3: undefined};
var tcpSocket = undefined;

var DEBUG = process.env.DEBUG ? process.env.DEBUG : false;


var debug = function() {
   if (DEBUG) {
      [].unshift.call(arguments, '[DEBUG 6brain] ');
      console.log.apply(console, arguments);
   };
}

// // Transform a networkType (as returned by AT^SYSINFO) in a sendable data
// function getSendableType(type) {
// 	if (type === undefined || type < 2)
// 		return '0';	// No internet
// 	if (type === 2)
// 		return '1';	// GPRS
// 	if (type === 3)
// 		return '2';	// EDGE
// 	if (type === 4)
// 		return '3';	// 3G
// 	if (type > 4)
// 		return '4';	// 3G+ or better
// 	return '0';
// }

quipu.handle('initialize', devices, PIN);

quipu.on('transition', function (data) {
	console.log('Transitioned from ' + data.fromState + ' to ' + data.toState);

   if (data.toState === "initialized")
      send('initialized')
   if (data.toState === "3G_connected")
      send('3G_connected')
   if (data.toState === "tunnelling")
      send('tunnelling')

	if (data.fromState === 'uninitialized' && data.toState === 'initialized') {

		console.log('quipu initialized');
		console.log('opening 3G');
		quipu.handle('open3G');
	}
	else if (data.toState === '3G_connected') {
      if (data.fromState === 'initialized') {
   		console.log('3G initialized');

   		tcpClient.start({host: connectInfo.host, port: connectInfo.port, name: connectInfo.name},
            function(err, client) {
            if (err) {
               console.log('[ERROR] : ' + err.message);
               quipu.handle('close3G')
               process.exit(-1);
            }


            tcpSocket = client;
            send('init', 'clear');

            client.on('data', function(d) {
               var command = d.toString().replace('\r', '').replace('\n', '');
               if (command.toString().slice(0, 4) === 'cmd:') {
                  debug('command received by TCP : ' + command)
                  var cmdArgs = command.toString().slice(4).split(' ');
                  commandHandler(cmdArgs, send);
               }
            })

            client.on('end', function() {
               console.log("server disconnected");
               quipu.handle('close3G');
               client.end();
               process.exit(1);
            });

         });

     //     // Set the heartbeat message to the network type (2G, 3G...)
   		// quipu.askNetworkType();
   		// tcpClient.setHeartbeatMessage('net' + getSendableType(quipu.getNetworkType()));
   		// setInterval(function() {
			  //  quipu.askNetworkType();
			  //  tcpClient.setHeartbeatMessage('net' + getSendableType(quipu.getNetworkType()));
   		// }, tcpClient.timeout < 20 ? tcpClient.timeout * 1000 / 2 : 10000);
      }

      sensor.record(MEASURE_PERIOD);
      if (tunnelInfo.shouldTunnel) {
         quipu.handle(tunnelInfo.arg1, tunnelInfo.arg2, tunnelInfo.arg3);
         tunnelInfo = {shouldTunnel: false, arg1: undefined, arg2: undefined, arg3: undefined};
      }
	}
});

quipu.on('3G_error', function() {
   console.log('exiting');
   process.exit(-1);
});

quipu.on('smsReceived', function(sms) {
	console.log('SMS received : \"' + sms.body + '\" ' + 'from \"' + sms.from + '\"');
	if (sms.body.toString().slice(0, 4) === 'cmd:' && authorizedNumbers.indexOf(sms.from) > -1) {
		var cmdArgs = sms.body.toString().slice(4).split(' ');
		commandHandler(cmdArgs, send);
	}
});

// 6SENSE BLOCK

sensor.on('processed', function(results) {
   sixSenseCodec([results]).then(function(message){
      if (smsMonitoring)
         sendSMS('1' + message);
      sendTCP('1' + message);
   });
});

sensor.on('transition', function (data){
   send(':', 'generic_encoded');
});

// stop measurments at SLEEP_HOUR_UTC
schedule.scheduleJob('00 '+SLEEP_HOUR_UTC+' * * *', function(){
   console.log('Pausing measurments.');
   sensor.pause();
});

// restart measurments at WAKEUP_HOUR_UTC
schedule.scheduleJob('00 '+ WAKEUP_HOUR_UTC +' * * *', function(){
   console.log('Restarting measurments.');
   sensor.record(MEASURE_PERIOD);
});


// SEND MESSAGE BLOCK

function sendSMS(message) {
   if (smsServer.match(/^\+{0,1}\d{11}$/))
      quipu.sendSMS(message, (smsServer.slice(0, 1) !== '+' ? smsServer : smsServer.slice(1)));
}

function sendTCP(message) {
   if (tcpClient) {
      debug('sending message to the TCP server')
      tcpClient.send(message);
   }
}

// Encode and send data
function send(message, encode) {
   if (encode === 'generic_encoded') {
      var body = {
      info:
         {command: message.split(':')[0], result: message.split(':')[1]},
         quipu: {
            state: quipu.state,
            signal: quipu.signalStrength
         },
         sense: sensor.state,
      };
      genericCodec.encode(body)
      .then(function(newMessage){
         if (smsMonitoring)
            sendSMS('2' + newMessage);
         sendTCP('2' + newMessage);
      })
   }
   else {
      if (smsMonitoring)
         sendSMS('0' + message);
      sendTCP('0' + message);
   }
}


// COMMAND BLOCK

function commandHandler(commandArgs, sendFunction) { // If a status is sent, his pattern is [command]:[status]

   var command = (commandArgs.length >= 1) ? commandArgs[0] : undefined;
   debug('command received : ' + command + '. callback : ' + sendFunction.name)

   switch(commandArgs.length) {

      case 1:
            // command with no parameter
         switch(command) {
            case 'status':               // Send the quipu and 6sense sensor
               if (sendFunction.name === 'send')
                  sendFunction(command + ':OK', 'generic_encoded')
               else
                  sendFunction("quipu: " + quipu.state + ",sensor : " + sensor.state);
               break;
            case 'reboot':               // Reboot the system
               spawn('reboot');
               break;
            case 'ip':                   // Send the ant's IP (SMS ONLY)
               var ips = getIp();
               var response = Object.keys(ips).map(function(k){sendFunction(k+' : '+ips[k])}).join('  ');
               sendFunction(response);
               break;
            case 'resumerecord':         // Start recording
               sensor.record(MEASURE_PERIOD);
               sendFunction(command + ':OK', 'generic_encoded');
               break;
            case 'pauserecord':          // Pause recording
               sensor.pause();
               sendFunction(command + ':OK', 'generic_encoded');
               break;
            case 'open3g':               // Open the 3G connection (SMS ONLY)
               quipu.handle('open3G');
               break;
            case 'close3g':              // Close the 3G connection (SMS ONLY)
               tunnelInfo =
                  {shouldTunnel: false, arg1: undefined, arg2: undefined, arg3: undefined};
               if (tcpSocket)
                  tcpSocket.end();
               quipu.handle('close3G');
               break;
            case 'closetunnel':          // Close the SSH tunnel
               tunnelInfo =
                  {shouldTunnel: false, arg1: undefined, arg2: undefined, arg3: undefined};
               quipu.handle('closetunnel');
               break;
            case 'ping':                 // Just send 'pong' to the server
               sendFunction('pong');
               break;
         }
         break;

      case 2:
            // command with one parameters
         switch(command) {
            case 'changeperiod':         // Change the period of recording
               if (commandArgs[1].toString().match(/^\d{1,5}$/)) {
                  MEASURE_PERIOD = parseInt(commandArgs[1], 10);
                  sensor.pause();

                  setTimeout(function(){
                     sensor.record(MEASURE_PERIOD);
                     sendFunction(command + ':OK', 'generic_encoded');
                     }, 3000)
                  } else {
                     console.log('Period is not an integer ', commandArgs[1]);
                  }
               break;
            case 'changestarttime':      // Change the hour when it starts recording
               if (commandArgs[1].toString().match(/^\d{1, 2}$/)) {
                  WAKEUP_HOUR_UTC = commandArgs[1];
                  sendFunction(command + ':OK', 'generic_encoded');
               }
               else
                  sendFunction(command + ':KO', 'generic_encoded');
               break;
            case 'changestoptime':       // Change the hour when it stops recording
               if (commandArgs[1].toString().match(/^\d{1, 2}$/)) {
                  SLEEP_HOUR_UTC = commandArgs[1];
                  sendFunction(command + ':OK', 'generic_encoded');
               }
               else
                  sendFunction(command + ':KO', 'generic_encoded');
               break;
            case 'changedestination':    // Change the SMS server
               if (commandArgs[1].toString().match(/^\+\d{11}$/)) {
                  smsServer = commandArgs[1].toString();
                  sendFunction(command + ':OK', 'generic_encoded');
               }
               else
                  sendFunction(command + ':KO', 'generic_encoded');
               break;
            case 'smsmonitor':           // set the smsMonitoring mode
               if (commandArgs[1].toString().toLowerCase() === 'on') {
                  smsMonitoring = true;
                  sendFunction(command + ':OK', 'generic_encoded');
               }
               else if (commandArgs[1].toString().toLowerCase() === 'off') {
                  smsMonitoring = false;
                  sendFunction(command + ':OK', 'generic_encoded');
               }
               else
                  sendFunction(command + ':KO', 'generic_encoded');
               case 'date':                 // Set the current time (synchronise server and client)
                  var date = commandArgs[1].replace('T', ' ').split('.')[0];
                  spawn('timedatectl', ['set-time', date]);

                  // check if current time is valid and record consequently
                  var current_hour = new Date().getHours();
                  if (current_hour <= SLEEP_HOUR_UTC && current_hour >= WAKEUP_HOUR_UTC)
                     sensor.record(MEASURE_PERIOD);

                  setTimeout(function(){
                     sendFunction(command + ':OK', 'generic_encoded');
                  }, 3000)
               break;
         }
         break;

      case 4:
            // command with three parameters
         switch(command) {
            case 'opentunnel':           // Open an SSH tunnel for distant access
               if (quipu.state !== '3G_connected')
                  quipu.handle('opentunnel', commandArgs[1], commandArgs[2], commandArgs[3])
               else {
                  tunnelInfo =
                     {shouldTunnel: false, arg1: commandArgs[1], arg2: commandArgs[2], arg3: commandArgs[3]};
                     quipu.handle('open3G');
                  }
               break;
         }
         break;

      default:
         console.log('Unrecognized command.', commandArgs)
         break;
   }
}
