"use strict";

var os = require('os');
var mqtt = require('mqtt')
var spawn = require('child_process').spawn;
var schedule = require('node-schedule');
var fs = require('fs');

var quipu = require('quipu');
var wifi = require('6sense').wifi;
var bluetooth = require('6sense').bluetooth;
var sixSenseCodec = require('pheromon-codecs')

var PRIVATE = require('../PRIVATE.json');


// === to set ===
// var devices = "SIM908";

var devices = {
    modem: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0',
    sms: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0'
};

var MEASURE_PERIOD = 300; // in seconds
var WAKEUP_HOUR_UTC = '07';
var SLEEP_HOUR_UTC = '16';
// ===

var simId;

var signal = 'NODATA';
var DEBUG = process.env.DEBUG || false;

var connectTimeout;
var reconnectAttempts = 0;
var simIdAttempts = 0;

var debug = function() {
    if (DEBUG) {
        [].unshift.call(arguments, '[DEBUG 6brain] ');
        console.log.apply(console, arguments);
    };
}

// mqtt client
var client;

// Open a file for measurement logs
var measurementLogs = fs.createWriteStream('measurements.log', {flags: 'a'});


// MQTT BLOCK

/*
** Subscribed on :
**  all
**  simId
**
** Publish on :
**  init/simId
**  status/simId/wifi
**  status/simId/blue
**  status/simId/quipu
**  measurement/simId/wifi
**  measurement/simId/blue
**  cmdResult/simId
*/

function send(topic, message) {
    if (client)
        client.publish(topic, message);
    else {
        debug("mqtt client not ready");
        setTimeout(function() {
            send(topic, message);
        }, 10000);
    }
}

function mqttConnect() {

    if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = undefined;
    }

    if (simId === undefined) {

        if (++simIdAttempts >= 10) {
            console.log('[ERROR] Cannot retrieve simId, restarting 6brain.');
            process.exit(1);
        }
        setTimeout(mqttConnect, 10000);
        return ;
    }
    else
        simIdAttempts = 0;
    var reconnectAttempts = 0;

    client = mqtt.connect('mqtt://' + PRIVATE.connectInfo.host + ':' + PRIVATE.connectInfo.port,
                    {
                        username: simId,
                        password: PRIVATE.connectInfo.password,
                        clientId: simId
                    });

    client.on('connect', function(){
        reconnectAttempts = 0;
        console.log('connected to the server');
        client.subscribe('all');
        client.subscribe(simId);
        send('init/' + simId, '');
    });

    client.on('message', function(topic, message) {
        // message is a Buffer
        console.log("data received : " + message.toString());

        commandHandler(message.toString(), send, 'cmdResult/'+simId);
    });

    client.on('close', function() {
        console.log('MQTT disconnection');

        if (++reconnectAttempts >= 10) {
            console.log('[ERROR] Impossible to reconnect, restarting 6brain')
            measurementLogs.close();
            process.exit(1);
        }

        if (!connectTimeout)
            connectTimeout = setTimeout(mqttConnect, 10000); // Be warning : recursive
    });

    client.on('error', function(err){
        console.log('MQTT error while connecting :', err)
        if (++reconnectAttempts >= 10) {
            console.log('[ERROR] Impossible to connect, restarting 6brain')
            measurementLogs.close();
            process.exit(1);
        }

        if (!connectTimeout)
            connectTimeout = setTimeout(mqttConnect, 10000); // Be warning : recursive
    });
}

// QUIPU BLOCK

spawn('killall', ["pppd"]);
quipu.handle('initialize', devices, PRIVATE.PIN);

quipu.on('transition', function (data) {
    console.log('Transitioned from ' + data.fromState + ' to ' + data.toState);


    if (data.fromState === 'uninitialized' && data.toState === 'initialized') {

        console.log('quipu initialized');
        console.log('opening 3G');
        quipu.handle('open3G', PRIVATE.connectInfo.apn);
        quipu.askNetworkType();

    }

    if (data.toState === '3G_connected') {
        if (data.fromState === 'initialized') {
            console.log('3G initialized');
            mqttConnect();

            // ask the connection type.
            setInterval(quipu.askNetworkType, 10000);
        }

    }

    if (data.fromState === '3G_connected' && data.toState === 'tunnelling') {
        send('cmdResult/'+simId, JSON.stringify({command: 'opentunnel', result: 'OK'}));
    }

    send('status/'+simId+'/quipu', data.toState);
});

quipu.on('3G_error', function() {
    console.log('exiting');
    process.exit(-1);
});

quipu.on('tunnelError', function(err) {
    console.log('tunnel error');
    send('cmdResult/'+simId, JSON.stringify({command: 'opentunnel', result: 'Error : '+err}));
});

quipu.on('smsReceived', function(sms) {
    console.log('SMS received : \"' + sms.body + '\" ' + 'from \"' + sms.from + '\"');
    if (sms.body.toString().slice(0, 4) === 'cmd:' && PRIVATE.authorizedNumbers.indexOf(sms.from) > -1) {
        var cmdArgs = sms.body.toString().toLowerCase().slice(4);
        commandHandler(cmdArgs, send, 'cmdResult/'+simId);
    }
});

quipu.on('simId', function(_simId) {
    simId = _simId;
    console.log('simId retrieved :', simId);
});

quipu.on('networkType', function(networkType) {
    if (networkType !== signal) {
        signal = networkType;
        // TODO ? Send signal to the server
    }
})

// 6SENSE BLOCK

var restart6senseIfNeeded = function(){
    return new Promise(function (resolve) {
        wifi.pause();
        bluetooth.pause();
        setTimeout(function(){
            var date = new Date();
            var current_hour = date.getHours();
            if (current_hour < parseInt(SLEEP_HOUR_UTC) && current_hour >= parseInt(WAKEUP_HOUR_UTC)){
                wifi.record(MEASURE_PERIOD);
                bluetooth.record(MEASURE_PERIOD);
            }
            resolve();
        }, 3000);
    });
}

// stop measurements at SLEEP_HOUR_UTC
var stopJob = schedule.scheduleJob('00 '+ SLEEP_HOUR_UTC + ' * * *', function(){
    console.log('Pausing measurements.');
    wifi.pause();
    bluetooth.pause();
});

// restart measurements at WAKEUP_HOUR_UTC
var startJob = schedule.scheduleJob('00 ' + WAKEUP_HOUR_UTC + ' * * *', function(){
    console.log('Restarting measurements.');
    wifi.record(MEASURE_PERIOD);
    bluetooth.record(MEASURE_PERIOD);
});



// 6SENSE WIFI BLOCK

wifi.on('monitorError', function (error) {
    spawn('reboot');
})

wifi.on('processed', function(results) {
    sixSenseCodec.encode(results).then(function(message){
        send('measurement/'+simId+'/wifi', message);
        measurementLogs.write(message + '\n');
    });
});

wifi.on('transition', function (status){
    send('status/'+simId+'/wifi', status);
});


// 6SENSE BLUETOOTH BLOCK

bluetooth.on('processed', function(results) {
    sixSenseCodec.encode(results).then(function(message){
        send('measurement/'+simId+'/bluetooth', message);
        measurementLogs.write(message + '\n');
    });
});

bluetooth.on('transition', function (status){
    send('status/'+simId+'/bluetooth', status);
});

// COMMAND BLOCK

function commandHandler(fullCommand, sendFunction, topic) { // If a status is sent, his pattern is [command]:[status]

    var commandArgs = fullCommand.split(' ');
    var command = (commandArgs.length >= 1) ? commandArgs[0] : undefined;
    debug('command received : ' + command);
    debug("args :", commandArgs);

    switch(commandArgs.length) {

        case 1:
            // command with no parameter
            switch(command) {
                case 'status':               // Send statuses
                    send('status/'+simId+'/quipu', quipu.state);
                    send('status/'+simId+'/wifi', wifi.state);
                    send('status/'+simId+'/bluetooth', bluetooth.state);
                    sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                    break;
                case 'reboot':               // Reboot the system
                    sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                    spawn('reboot');
                    break;
                case 'resumerecord':         // Start recording
                    wifi.record(MEASURE_PERIOD);
                    bluetooth.record(MEASURE_PERIOD);
                    sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                    break;
                case 'pauserecord':          // Pause recording
                    wifi.pause();
                    bluetooth.pause();
                    sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                    break;
                case 'closetunnel':          // Close the SSH tunnel
                    quipu.handle('closeTunnel');
                    sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                    break;
            }
            break;

        case 2:
            // command with one parameters
            switch(command) {
                case 'changeperiod':
                    if (commandArgs[1].toString().match(/^\d{1,5}$/)) {
                        MEASURE_PERIOD = parseInt(commandArgs[1], 10);

                        restart6senseIfNeeded()
                        .then(function () {
                            sendFunction(topic, JSON.stringify({command: command, result: commandArgs[1]}));
                        });

                    } else {
                        console.log('Period is not an integer ', commandArgs[1]);
                        sendFunction(topic, JSON.stringify({command: command, result: 'KO'}));
                    }
                    break;
                case 'changestarttime':      // Change the hour when it starts recording
                    if (commandArgs[1].match(/^\d{1,2}$/)) {
                        WAKEUP_HOUR_UTC = commandArgs[1];

                        restart6senseIfNeeded()
                        .then(function () {
                            sendFunction(topic, JSON.stringify({command: command, result: commandArgs[1]}));
                        });

                        startJob.cancel();
                        startJob = schedule.scheduleJob('00 ' + WAKEUP_HOUR_UTC + ' * * *', function(){
                            console.log('Restarting measurements.');

                            wifi.record(MEASURE_PERIOD);
                            bluetooth.record(MEASURE_PERIOD);
                        });
                    }
                    else
                        sendFunction(topic, JSON.stringify({command: command, result: 'KO'}));
                    break;
                case 'changestoptime':       // Change the hour when it stops recording
                    if (commandArgs[1].match(/^\d{1,2}$/)) {
                        SLEEP_HOUR_UTC = commandArgs[1];

                        restart6senseIfNeeded()
                        .then(function () {
                            sendFunction(topic, JSON.stringify({command: command, result: commandArgs[1]}));
                        });

                        stopJob.cancel();
                        stopJob = schedule.scheduleJob('00 '+ SLEEP_HOUR_UTC + ' * * *', function(){
                            console.log('Pausing measurements.');

                            wifi.pause();
                            bluetooth.pause();
                        });
                    }
                    else
                        sendFunction(topic, JSON.stringify({command: command, result: 'KO'}));
                    break;
                case 'date':                 // Change the sensor's date
                    var date = commandArgs[1].replace('t', ' ').split('.')[0];
                    spawn('timedatectl', ['set-time', date]);

                    restart6senseIfNeeded()
                    .then(function () {
                        sendFunction(topic, JSON.stringify({command: command, result: commandArgs[1]}));
                    });
                    break;
            }
            break;

        case 4:
            // command with three parameters
            switch(command) {
                case 'opentunnel':           // Open a reverse SSH tunnel
                    debug("sending tunnel command");
                    quipu.handle('openTunnel', commandArgs[1], commandArgs[2], commandArgs[3])
                    break;
            }
            break;

        case 5:
            // command with four parameters
            switch(command) {
                case 'init':                 // Initialize period, start and stop time
                    debug("received init command");
                    if (commandArgs[1].toString().match(/^\d{1,5}$/) && commandArgs[2].match(/^\d{1,2}$/) && commandArgs[3].match(/^\d{1,2}$/)) {
                        var date = commandArgs[4].replace('t', ' ').split('.')[0];
                        spawn('timedatectl', ['set-time', date]);
                        MEASURE_PERIOD = parseInt(commandArgs[1], 10);

                        WAKEUP_HOUR_UTC = commandArgs[2];
                        startJob.cancel();
                        startJob = schedule.scheduleJob('00 ' + WAKEUP_HOUR_UTC + ' * * *', function(){
                            console.log('Restarting measurements.');
                            wifi.record(MEASURE_PERIOD);
                            bluetooth.record(MEASURE_PERIOD);
                        });

                        SLEEP_HOUR_UTC = commandArgs[3];
                        stopJob.cancel();
                        stopJob = schedule.scheduleJob('00 '+ SLEEP_HOUR_UTC + ' * * *', function(){
                            console.log('Pausing measurements.');
                            wifi.pause();
                            bluetooth.pause();
                        });

                        restart6senseIfNeeded()
                        .then(function () {
                            sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                        });

                    }
                    break;
            }
            break;

        default:
            console.log('Unrecognized command.', commandArgs)
            break;
    }
}
