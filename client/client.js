"use strict";

var os = require('os');
var spawn = require('child_process').spawn;
var net = require('net');
var schedule = require('node-schedule');

var quipu = require('quipu');
var sensor = require('6sense');
var sixSenseCodec = require('6sense/src/codec/encodeForSMS.js')
var genericCodec = require('quipu/parser.js');
var getIp = require('./getIp.js');

var PRIVATE = require('./PRIVATE.json');


// === to set ===
var devices = {
	modem: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0',
	sms: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0'
};

var MEASURE_PERIOD = 10; // in seconds
var WAKEUP_HOUR_UTC = '07';
var SLEEP_HOUR_UTC = '16';
// === 


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


// TCP BLOCK
function tcpConnect() { 

   var socket = net.connect(PRIVATE.connectInfo);

   socket.on('connect', function(){
      console.log('connected to the server');
      tcpSocket = socket;
      socket.write("name=" + PRIVATE.connectInfo.name);
   });

   socket.on('data', function(data) {
      console.log("data received : " + data.toString());
      if (data.toString().slice(0, 4) === 'cmd:') {
         var cmdArgs = data.toString().slice(4).split(' ');
         commandHandler(cmdArgs, send);
      }
   });

   socket.on('end', function() {
      console.log("tcp disconnected");
      setTimeout(tcpConnect, 10000); // Be warning : recursive
   });

   socket.on('close', function() {
      console.log("tcp disconnected");
      setTimeout(tcpConnect, 10000); // Be warning : recursive
   });

   socket.on('error', function(err){
      console.log("tcp error", err);
   });
}

// QUIPU BLOCK

quipu.handle('initialize', devices, PRIVATE.PIN);

quipu.on('transition', function (data) {
	console.log('Transitioned from ' + data.fromState + ' to ' + data.toState);

   if (data.toState === "tunnelling")
      send('tunnelling')

	if (data.fromState === 'uninitialized' && data.toState === 'initialized') {

		console.log('quipu initialized');
		console.log('opening 3G');
		quipu.handle('open3G');
	}

	if (data.toState === '3G_connected') {
      if (data.fromState === 'initialized') {
   		console.log('3G initialized');
         tcpConnect();
      }

      // sensor.record(MEASURE_PERIOD);

      if (tunnelInfo.shouldTunnel) {
         quipu.handle(tunnelInfo.arg1, tunnelInfo.arg2, tunnelInfo.arg3);
         tunnelInfo = {shouldTunnel: false, arg1: undefined, arg2: undefined, arg3: undefined};
         sendFunction('opentunnel:OK', generic_encoded);
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
      sendTCP('1' + message);
   });
});

sensor.on('transition', function (data){
   send('null:null', 'generic_encoded');
});

// stop measurments at SLEEP_HOUR_UTC
schedule.scheduleJob('00 '+ SLEEP_HOUR_UTC + ' * * *', function(){
   console.log('Pausing measurments.');
   sensor.pause();
});

// restart measurments at WAKEUP_HOUR_UTC
schedule.scheduleJob('00 ' + WAKEUP_HOUR_UTC + ' * * *', function(){
   console.log('Restarting measurments.');
   sensor.record(MEASURE_PERIOD);
});




// SEND MESSAGE BLOCK

function sendTCP(message) {
   if (tcpSocket)
      tcpSocket.write(message);
   else
      console.log("tcpSocket not ready for message, ", message);
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
         sendTCP('2' + newMessage);
      })
   }
   else {
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
               if (quipu.state === 'tunnelling')
                  sendFunction(command + ':OK', 'generic_encoded');
               else
                  sendFunction(command + ':KO', 'generic_encoded');
               break;
            case 'ping':                 // Just send 'pong' to the server
               sendFunction('pong');
               break;
         }
         break;

      case 2:
            // command with one parameters
         switch(command) {
            case 'changeperiod':
               console.log("")         // Change the period of recording
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
               if (commandArgs[1].toString().match(/^\d{1,2}$/)) {
                  WAKEUP_HOUR_UTC = commandArgs[1];
                  sendFunction(command + ':' + commandArgs[1], 'generic_encoded');
               }
               else
                  sendFunction(command + ':KO', 'generic_encoded');
               break;
            case 'changestoptime':       // Change the hour when it stops recording
               if (commandArgs[1].toString().match(/^\d{1,2}$/)) {
                  SLEEP_HOUR_UTC = commandArgs[1];
                  sendFunction(command + ':' + commandArgs[1], 'generic_encoded');
               }
               else
                  sendFunction(command + ':KO', 'generic_encoded');
               break;
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
