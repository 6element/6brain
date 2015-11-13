"use strict";

var mqtt = require('mqtt');
var spawn = require('child_process').spawn;
var schedule = require('node-schedule');
var fs = require('fs');

var quipu = require('quipu');
var wifi = require('6sense').wifi();
var bluetooth = require('6sense').bluetooth();
var sixSenseCodec = require('pheromon-codecs').signalStrengths;
var trajectoriesCodec = require('pheromon-codecs').trajectories;

var PRIVATE = require('./PRIVATE.json');


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

// Quipu infos
var simId;
var signal = 'NODATA';

var hasBeenConnected = false;
var simIdAttempts = 0;

// Measurement hour start/stop cronjobs
var startJob;
var stopJob;

// Debug logger
var DEBUG = process.env.DEBUG || false;
var debug = function() {
    if (DEBUG) {
        [].unshift.call(arguments, '[DEBUG 6brain] ');
        console.log.apply(console, arguments);
    }
};


// mqtt client
var client;

// Open a file for measurement logs
var measurementLogs = fs.createWriteStream('measurements.log', {flags: 'a'});


// UTILS BLOCK

// Restart 6sense processes if the date is in the range.
function restart6senseIfNeeded() {
    return new Promise(function (resolve) {
        wifi.pause();
        bluetooth.pause();
        setTimeout(function(){
            var date = new Date();
            var current_hour = date.getHours();

            if (current_hour < parseInt(SLEEP_HOUR_UTC, 10) && current_hour >= parseInt(WAKEUP_HOUR_UTC, 10)) {
                debug('Restarting measurements.');
                wifi.record(MEASURE_PERIOD);
                bluetooth.record(MEASURE_PERIOD);
            }

            resolve();
        }, 3000);
    });
}

function createStartJob() {
    return schedule.scheduleJob('00 ' + WAKEUP_HOUR_UTC + ' * * *', function(){
        console.log('Restarting measurements.');
        wifi.record(MEASURE_PERIOD);
        bluetooth.record(MEASURE_PERIOD);
    });
}

function createStopJob() {
    return schedule.scheduleJob('00 '+ SLEEP_HOUR_UTC + ' * * *', function(){
        console.log('Pausing measurements.');
        wifi.pause();
        bluetooth.pause();
    });
}

function changeDate(newDate) {
    return new Promise(function(resolve, reject) {
        // Cancel every 'cronjobs' (They don't like system time changes)
        if (startJob)
            startJob.cancel();
        if (stopJob)
            stopJob.cancel();
        if (wifi)
            wifi.stopTrajectoriesSendJob();

        // Change the date
        var child = spawn('date', ['-s', newDate]);

        child.stderr.on('data', function(data) {
            console.log(data.toString());
        });


        child.on('close', function () {
            // Restart all cronjobs
            startJob = createStartJob();
            stopJob = createStopJob();

            if (wifi)
                wifi.restartTrajectoriesSendJob();

            restart6senseIfNeeded()
            .then(resolve)
            .catch(reject);
        });
    });
}

function send(topic, message, options) {
    if (!simId) {
        debug('simId not set');
        return false;
    }
    if (client)
        client.publish(topic, message, options);
    else {
        debug("mqtt client not ready");
        setTimeout(function() {
            send(topic, message, options);
        }, 10000);
    }
}



// MQTT BLOCK

/*
** Subscribed on :
**  all
**  simId
**
** Publish on :
**  init/simId
**  status/simId/wifi
**  status/simId/bluetooth
**  status/simId/signal
**  status/simId/client
**  measurement/simId/wifi
**  measurement/simId/bluetooth
**  measurement/simId/trajectories
**  cmdResult/simId
*/

function mqttConnect() {

    if (simId === undefined) {

        if (++simIdAttempts >= 10) {
            console.log('[ERROR] Cannot retrieve simId, restarting 6brain.');
            process.exit(1);
        }
        setTimeout(mqttConnect, 10000);
        return;
    }
    else
        simIdAttempts = 0;

    client = mqtt.connect('mqtt://' + PRIVATE.connectInfo.host + ':' + PRIVATE.connectInfo.port,
                    {
                        username: simId,
                        password: PRIVATE.connectInfo.password,
                        clientId: simId,
                        keepalive: 0,
                        clean: false,
                        reconnectPeriod: 1000 * MEASURE_PERIOD / 2
                    });

    if (!hasBeenConnected) {
        hasBeenConnected = true;
        client.on('connect', function(){
            console.log('connected to the server. ID :', simId);
            client.subscribe('all');
            client.subscribe(simId);
            send('init/' + simId, '');
        });

        client.on('message', function(topic, message) {
            // message is a Buffer
            console.log("data received : " + message.toString());

            commandHandler(message.toString(), send, 'cmdResult/'+simId);
        });
    }
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
    }

    if (data.toState === '3G_connected') {
        if (data.fromState === 'initialized') {
            console.log('3G initialized');
            mqttConnect();
        }

    }

    if (data.fromState === 'tunnelling' && data.toState === '3G_connected') {
        send('cmdResult/'+simId, JSON.stringify({command: 'closetunnel', result: 'OK'}));
        send('status/'+simId+'/client', 'connected');
    }
    else if (data.fromState === '3G_connected' && data.toState === 'tunnelling') {
        send('cmdResult/'+simId, JSON.stringify({command: 'opentunnel', result: 'OK'}));
        send('status/'+simId+'/client', 'tunnelling');
    }
});

quipu.on('3G_error', function () {
    console.log('exiting');
    process.exit(-1);
});

quipu.on('hardwareError', function () {
    console.log('exiting');
    process.exit(-1);
});

quipu.on('tunnelError', function (err) {
    console.log('tunnel error');
    send('cmdResult/'+simId, JSON.stringify({command: 'opentunnel', result: 'Error : '+err}));
});

quipu.on('smsReceived', function (sms) {
    console.log('SMS received : \"' + sms.body + '\" ' + 'from \"' + sms.from + '\"');
    if (sms.body.toString().slice(0, 4) === 'cmd:' && PRIVATE.authorizedNumbers.indexOf(sms.from) > -1) {
        var cmdArgs = sms.body.toString().toLowerCase().slice(4);
        commandHandler(cmdArgs, send, 'cmdResult/'+simId);
    }
});

quipu.on('simId', function (_simId) {
    simId = _simId;
    console.log('simId retrieved :', simId);

    // ask the connection type.
    quipu.askNetworkType();
    setInterval(quipu.askNetworkType, 10000);
});

quipu.on('networkType', function (networkType) {
    if (networkType !== signal && networkType !== 'H/H+') {
        signal = networkType;
        send('status/'+simId+'/signal', signal);
    }
});



// 6SENSE BLOCK

// restart measurements at WAKEUP_HOUR_UTC
startJob = createStartJob();

// stop measurements at SLEEP_HOUR_UTC
stopJob = createStopJob();



// 6SENSE WIFI BLOCK

wifi.on('monitorError', function () {

    spawn('reboot');
});

wifi.on('processed', function (results) {
    sixSenseCodec.encode(results).then(function(message){
        send('measurement/'+simId+'/wifi', message, {qos: 1});
        measurementLogs.write(message + '\n');
    });
});

wifi.on('transition', function (status){
    send('status/'+simId+'/wifi', status.toState);
    debug('wifi status sent :', status.toState);
});

wifi.on('trajectories', function (trajectories) {
    console.log('trajectories received');
    trajectoriesCodec.encode(trajectories)
    .then(function (message) {
        send('measurement/'+simId+'/trajectories', message, {qos: 1});
        measurementLogs.write(message + '\n');
    });
});


// 6SENSE BLUETOOTH BLOCK

bluetooth.on('processed', function (results) {
    sixSenseCodec.encode(results).then(function(message){
        send('measurement/'+simId+'/bluetooth', message, {qos: 1});
        measurementLogs.write(message + '\n');
    });
});

bluetooth.on('transition', function (status){
    send('status/'+simId+'/bluetooth', status.toState);
    debug('bluetooth status sent :', status.toState);
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
                    send('status/'+simId+'/signal', signal);
                    send('status/'+simId+'/wifi', wifi.state);
                    send('status/'+simId+'/bluetooth', bluetooth.state);
                    send('status/'+simId+'/client', quipu.state === 'tunnelling' ? 'tunnelling' : 'connected');
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
                    break;
            }
            break;

        case 2:
            // command with one parameters
            switch(command) {
                case 'changeperiod':         // Change the time between two measurements
                    if (commandArgs[1].toString().match(/^\d{1,5}$/)) {
                        MEASURE_PERIOD = parseInt(commandArgs[1], 10);

                        restart6senseIfNeeded()
                        .then(function () {
                            sendFunction(topic, JSON.stringify({command: command, result: commandArgs[1]}));
                        })
                        .catch(function (err) {
                            console.log('Error in restart6senseIfNeeded :', err);
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
                        })
                        .catch(function (err) {
                            console.log('Error in restart6senseIfNeeded :', err);
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
                        })
                        .catch(function (err) {
                            console.log('Error in restart6senseIfNeeded :', err);
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

                    changeDate()
                    .then(function () {
                        sendFunction(topic, JSON.stringify({command: command, result: commandArgs[1]}));
                    })
                    .catch(function (err) {
                        console.log('Error in restart6senseIfNeeded :', err);
                    });
                    break;
            }
            break;

        case 4:
            // command with three parameters
            switch(command) {
                case 'opentunnel':           // Open a reverse SSH tunnel
                    debug("sending tunnel command");
                    quipu.handle('openTunnel', commandArgs[1], commandArgs[2], commandArgs[3]);
                    break;
            }
            break;

        case 5:
            // command with four parameters
            switch(command) {
                case 'init':                 // Initialize period, start and stop time
                    if (commandArgs[1].match(/^\d{1,5}$/) && commandArgs[2].match(/^\d{1,2}$/) && commandArgs[3].match(/^\d{1,2}$/)) {
                        var newDate = commandArgs[4].toUpperCase().replace('T', ' ').split('.')[0];

                        startJob.cancel();
                        stopJob.cancel();

                        MEASURE_PERIOD = parseInt(commandArgs[1], 10);
                        WAKEUP_HOUR_UTC = commandArgs[2];
                        SLEEP_HOUR_UTC = commandArgs[3];

                        changeDate(newDate)
                        .then(function () {
                            sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                        })
                        .catch(function (err) {
                            console.log('Error in changeDate:', err);
                            sendFunction(topic, JSON.stringify({command: command, result: err}));
                        });
                        debug('init done');

                    }
                    else {
                        sendFunction(topic, JSON.stringify({command: command, result: 'Error in arguments'}));
                        console.log('error in arguments of init');
                    }
                    break;
            }
            break;

        default:
            console.log('Unrecognized command.', commandArgs);
            break;
    }
}
