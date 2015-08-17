"use strict";

var os = require('os');
var spawn = require('child_process').spawn;
var net = require('net');
var schedule = require('node-schedule');

var quipu = require('quipu');
var sensor = require('6sense');
var sixSenseCodec = require('6sense/src/codec/encodeForSMS.js')
var genericCodec = require('quipu/parser.js');

var PRIVATE = require('../PRIVATE.json');


// === to set ===
var devices = {
	modem: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0',
	sms: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0'
};

var MEASURE_PERIOD = 10; // in seconds
var WAKEUP_HOUR_UTC = '07';
var SLEEP_HOUR_UTC = '16';
// === 

var signal = 'NODATA';
var tcpSocket = undefined;
var DEBUG = process.env.DEBUG ? process.env.DEBUG : false;


var debug = function() {
   if (DEBUG) {
      [].unshift.call(arguments, '[DEBUG 6brain] ');
      console.log.apply(console, arguments);
   };
}

// Transform a networkType (as returned by AT^SYSINFO) in a sendable data
function getSendableSignal(signal) {
	if (signal === undefined || signal < 2)
		return 'NODATA';	// No internet
	if (signal === 2)
		return 'GPRS';	// GPRS
	if (signal === 3)
		return 'EDGE';	// EDGE
	if (signal === 4)
		return '3G';	// 3G
	if (signal > 4)
		return 'H/H+';	// 3G+ or better
	return 'unknown';
}


// TCP BLOCK
function tcpConnect() { 

   var socket = net.connect(PRIVATE.connectInfo);

   socket.on('connect', function(){
      console.log('connected to the server');
      tcpSocket = socket;
      sendTCP("phoneNumber=" + PRIVATE.connectInfo.phoneNumber)
   });

   var chunk = "";
   var d_index;
   socket.on('data', function(data) {
      // accumulate tcp stream until \n meaning new chunk
      chunk += data.toString();
      d_index = chunk.indexOf('\n');

      while (d_index > -1) {         
         var message = chunk.substring(0, d_index); // Create string up until the delimiter
         console.log("data received : " + message);
         if (message.slice(0, 4) === 'cmd:') {
            var cmdArgs = message.toLowerCase().slice(4).split(' ');
            commandHandler(cmdArgs, send);
         }         
         chunk = chunk.substring(d_index + 1); // Cuts off the processed chunk
         d_index = chunk.indexOf('\n'); // Find the new delimiter
      } 

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


	if (data.fromState === 'uninitialized' && data.toState === 'initialized') {

		console.log('quipu initialized');
		console.log('opening 3G');
		quipu.handle('open3G');
      quipu.askNetworkType();

      setInterval(function(){
         quipu.askNetworkType();
         var tmp = getSendableSignal(quipu.getNetworkType());
         if (tmp != signal) {
            signal = tmp;
            send('net'+signal, 'clear');
         }
      }, 5000);
	}

	if (data.toState === '3G_connected') {
      if (data.fromState === 'initialized') {
   		console.log('3G initialized');
         tcpConnect();
      }

      if (data.toState === 'tunnelling') {
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
		var cmdArgs = sms.body.toString().toLowerCase().slice(4).split(' ');
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
      tcpSocket.write(message + "\n");
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
      },
      sense: sensor.state
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
   debug('command received : ' + command + '. callback : ' + sendFunction.name);
   debug("args :", commandArgs);

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
            case 'closetunnel':          // Close the SSH tunnel
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
                     sendFunction(command + ':' + commandArgs[1], 'generic_encoded');
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
            case 'date':
                  var date = commandArgs[1].replace('t', ' ').split('.')[0];
                  spawn('timedatectl', ['set-time', date]);

                  // check if current time is valid and record consequently
                  var current_hour = new Date().getHours();
                  if (current_hour <= parseInt(SLEEP_HOUR_UTC) && current_hour >= parseInt(WAKEUP_HOUR_UTC))
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
            case 'opentunnel':
               console.log("sending tunnel command");
               quipu.handle('openTunnel', commandArgs[1], commandArgs[2], commandArgs[3])
               break;
         }
         break;

      default:
         console.log('Unrecognized command.', commandArgs)
         break;
   }
}
