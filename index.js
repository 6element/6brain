"use strict";

var mqtt = require('mqtt');
var spawn = require('child_process').spawn;
var schedule = require('node-schedule');
var fs = require('fs');

var wifi = require('6sense').wifi();
var bluetooth = require('6sense').bluetooth();
var sixSenseCodec = require('pheromon-codecs').signalStrengths;
var trajectoriesCodec = require('pheromon-codecs').trajectories;

var trajectoriesCodecOptions = {
    precisionSignalStrength: 1,
    precisionDate: 30
}

var BinServer = require('6bin').BinServer;
var binServer = new BinServer();

var PRIVATE = require('./PRIVATE.json');


// === to set ===
var MEASURE_PERIOD = 300; // in seconds
var WAKEUP_HOUR_UTC = '07';
var SLEEP_HOUR_UTC = '16';
var SSH_TIMEOUT = 20 * 1000;
// ===

var simId = PRIVATE.sim;
var sshProcess;
var inited = false;

// Measurement hour start/stop cronjobs
var startJob;
var stopJob;
var trajJob;

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

function createTrajectoryJob() {
    return schedule.scheduleJob('00 00 * * *', function(){
        console.log('Sending trajectories');
        var trajectories = wifi.getTrajectories();
        trajectoriesCodec.encode(trajectories, trajectoriesCodecOptions)
        .then(function (message) {
            send('measurement/'+simId+'/trajectories', message, {qos: 1});
        });
    });
}

function changeDate(newDate) {
    return new Promise(function(resolve, reject) {
        // Cancel every 'cronjobs' (They don't like system time changes)
        if (startJob)
            startJob.cancel();
        if (stopJob)
            stopJob.cancel();
        if (trajJob)
            trajJob.cancel();

        // Change the date
        var child = spawn('date', ['-s', newDate]);

        child.stderr.on('data', function(data) {
            console.log(data.toString());
        });


        child.on('close', function () {
            // Restart all cronjobs
            startJob = createStartJob();
            stopJob = createStopJob();
            if (wifi.recordTrajectories)
                trajJob = createTrajectoryJob();

            restart6senseIfNeeded()
            .then(resolve)
            .catch(reject);
        });
    });
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
**  status/simId/client
**  measurement/simId/wifi
**  measurement/simId/bluetooth
**  measurement/simId/trajectories
**  cmdResult/simId
*/

function mqttConnect() {

    client = mqtt.connect('mqtt://' + PRIVATE.host + ':' + PRIVATE.port,
        {
            username: simId,
            password: PRIVATE.mqttToken,
            clientId: simId,
            keepalive: 60*60,
            clean: false,
            reconnectPeriod: 1000 * 60 * 10
        }
    );


    client.on('connect', function(){
        console.log('connected to the server. ID :', simId);
        client.subscribe('all', {qos: 1});
        client.subscribe(simId + '/#', {qos: 1});
        if (!inited) {
            send('init/' + simId, '');
            inited = true;
        }
    });

    client.on('offline', function(topic, message) {
        console.log("offline")
    })

    client.on('message', function(topic, buffer) {
        var destination = topic.split('/')[1]; // subtopics[0] is simId or all => irrelevant

        var message = buffer.toString();
        console.log("data received :", message, 'destination', destination);

        if (destination) {
            binServer.emit(destination, JSON.parse(message));
        }
        else
            commandHandler(message, send, 'cmdResult/'+simId);
    });
}

function send(topic, message, options) {
    if (client)
        client.publish(topic, message, options);
    else {
        debug("mqtt client not ready");
        setTimeout(function() {
            send(topic, message, options);
        }, 10000);
    }
}

function openTunnel(queenPort, antPort, target) {
            
    return new Promise(function(resolve, reject){
        var myProcess = spawn("ssh", ["-v", "-N", "-R", queenPort + ":localhost:" + antPort, target]);
        debug("nodeprocess :", myProcess.pid, "myProcess: ", process.pid);
        myProcess.stderr.on("data", function(chunkBuffer){
            var message = chunkBuffer.toString();
            debug("ssh stderr => " + message);
            if (message.indexOf("remote forward success") !== -1){
                resolve(myProcess);
            } else if (message.indexOf("Warning: remote port forwarding failed for listen port") !== -1){
                reject({process: myProcess, msg:"Port already in use."});
            }
        });
        // if no error after SSH_TIMEOUT 
        setTimeout(function(){reject({process: myProcess, msg:"SSH timeout"}); }, SSH_TIMEOUT);
    })

}

// 6SENSE BLOCK

// restart measurements at WAKEUP_HOUR_UTC
startJob = createStartJob();

// stop measurements at SLEEP_HOUR_UTC
stopJob = createStopJob();

// send trajectories at midnight
trajJob = createTrajectoryJob();



// 6SENSE WIFI BLOCK

wifi.on('monitorError', function () {
    console.log("ERROR on wifi detection");
});

wifi.on('processed', function (results) {
    console.log('wifi measurements received');
    debug({
        date: results.date,
        signals: results.devices.length
    });

    sixSenseCodec.encode(results).then(function(message){
        send('measurement/'+simId+'/wifi', message, {qos: 1});
    });
});

wifi.on('transition', function (status){
    send('status/'+simId+'/wifi', status.toState);
    debug('wifi status sent :', status.toState);
});


// 6SENSE BLUETOOTH BLOCK

bluetooth.on('processed', function (results) {
    console.log('bluetooth measurements received');
    debug({
        date: results.date,
        signals: results.devices.length
    });

    sixSenseCodec.encode(results).then(function(message){
        send('measurement/'+simId+'/bluetooth', message, {qos: 1});
    });
});

bluetooth.on('transition', function (status){
    send('status/'+simId+'/bluetooth', status.toState);
    debug('bluetooth status sent :', status.toState);
});


// 6BIN BLOCK

binServer.start(3000);

// These are what 6brain receives from 6bin server
binServer.on('measurementRequest', function(request){
    /* 
        measurement request: {
            date:
            value: [{}]
            (index:) -> reference to the 6bin local pending promise
            (origin:) -> so that pheromon knows it needs to send back smg
        }
    */

    var self = this;
    debug('msg received from 6bin client', request);

    send('measurement/' + simId + '/bin', JSON.stringify(request), {qos: 1});
});

var url = 'myURL';

binServer.on('binRequest', function(request){
    /*
        bins request: {
            bins: [BinData],
            (index:) -> reference to the 6bin local pending promise
            (origin:) -> so that pheromon knows it needs to send back smg
        }
    */

    var self = this;
    debug('msg received from 6bin client', request);

    var message = {
        url: url,
        method: 'POST', // because this query will modify bins on 6element DB
        data: request.bins,
        origin: request.origin,
        index: request.index
    };

    send('url/' + simId, JSON.stringify(message), {qos: 1});
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
                    sshProcess.kill('SIGINT');
                    setTimeout(function () {
                        if (sshProcess)
                            sshProcess.kill();
                    }, 2000);
                    send('cmdResult/'+simId, JSON.stringify({command: 'closetunnel', result: 'OK'}));
                    send('status/'+simId+'/client', 'connected');
                    break;
                case 'gettrajectories':
                    var trajectories = wifi.getTrajectories();
                    trajectoriesCodec.encode(trajectories, trajectoriesCodecOptions)
                    .then(function (message) {
                        send('measurement/'+simId+'/trajectories', message, {qos: 1});
                    });
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
                        sendFunction(topic, JSON.stringify({command: command, result: date}));
                    })
                    .catch(function (err) {
                        sendFunction(topic, JSON.stringify({command: command, result: err}));
                        console.log('Error in changeDate :', err);
                    });
                    break;
                case 'resumerecord':
                    var mtype = commandArgs[1];
                    if (mtype === "wifi")
                        wifi.record(MEASURE_PERIOD);
                    if (mtype === "bluetooth")
                        bluetooth.record(MEASURE_PERIOD);
                    if (mtype === "trajectories")
                        wifi.startRecordingTrajectories();
                    sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                    break;
                case 'pauserecord':
                    var mtype = commandArgs[1];
                    if (mtype === "wifi")
                        wifi.pause();
                    if (mtype === "bluetooth")
                        bluetooth.pause();
                    if (mtype === "trajectories")
                        wifi.stopRecordingTrajectories();
                    sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                    break;
            }
            break;

        case 4:
            // command with three parameters
            switch(command) {
                case 'opentunnel':           // Open a reverse SSH tunnel
                    openTunnel(commandArgs[1], commandArgs[2], commandArgs[3])
                    .then(function(process){
                        sshProcess = process;
                        send('cmdResult/'+simId, JSON.stringify({command: 'opentunnel', result: 'OK'}));
                        send('status/'+simId+'/client', 'tunnelling');
                    })
                    .catch(function(err){
                        console.log(err.msg);
                        console.log("Could not make the tunnel. Cleanning...");
                        send('cmdResult/'+simId, JSON.stringify({command: 'opentunnel', result: 'Error : '+err.msg}));
                    });
                    break;

                case 'init':                 // Initialize period, start and stop time
                    if (commandArgs[1].match(/^\d{1,5}$/) && commandArgs[2].match(/^\d{1,2}$/) && commandArgs[3].match(/^\d{1,2}$/)) {

                        MEASURE_PERIOD = parseInt(commandArgs[1], 10);
                        WAKEUP_HOUR_UTC = commandArgs[2];
                        SLEEP_HOUR_UTC = commandArgs[3];

                        restart6senseIfNeeded()
                        .then(function(){
                            sendFunction(topic, JSON.stringify({command: command, result: 'OK'}));
                            debug('init done');
                        })
                        .catch(function(){
                            sendFunction(topic, JSON.stringify({command: command, result: 'Error in restarting 6sense'}));
                        });

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

mqttConnect();
