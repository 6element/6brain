# 6brain

6brain is the core of the 6element sensors. It is responsible for data collection and transmission. It dependes on 
[6sense](https://github.com/anthill/6sense) for data collection and
[quipu](https://github.com/anthill/quipu) for transmission through 3G.

Juste use `node client/client.js` to start everything. You should create a file called `PRIVATE.json` with this pattern:

```
{
    "connectInfo":
    {
        "host":"127.0.0.1",
        "port":1111,
        "apn":"orange",
        "password":"0xBADF00D"
    },
    "authorizedNumbers":["+33611111111", "+33622222222"],
    "PIN": "0000"
}


```
* connectInfo :

	* host : the tcp server which you want to connect to

	* port : the port of the tcp server

	* apn : the apn used by the SIM card to connect to the internet

    * password : the password to connect to the MQTT network

* authorizedNumbers : phone numbers which can send command to the sensor

* PIN :

	The PIN number of the SIM card.


## Commands

6brain not only push datas, it can respond to sms and MQTT stimuli:

Here are some command examples

* `status` send back a message with the current status

* `changeperiod 30` change the period between two measurements to 30 seconds

* `openTunnel 2222 9632 kerrigan` opens a reverse ssh tunnel toward `kerrigan` (must be set in `~/.ssh/config`) and send a message once the tunnel is up.