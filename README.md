# 6brain

6brain is the core of the 6element sensors. It is responsible for data collection and transmission. It depense on [6sense](https://github.com/anthill/6sense) for data collection and [quipu](https://github.com/anthill/quipu) for transmission through sms.

Juste use `node index.js` to start everything. You should create a file called `PRIVATE.json` with this pattern:

```
{
    "connectInfo":
    {
        "host":"127.0.0.1",
        "port":1111,
        "phoneNumber":"+33600000000",
        "apn":"orange",
    },
    "smsServer":"+33611111111",
    "authorizedNumbers":["+33611111111", "+33622222222"],
    "smsMonitoring":false
    "PIN": "0000"
}


```
* connectInfo :

	* host : the tcp server which you want to connect to

	* port : the port of the tcp server

	* phoneNumber : phone number of the sensor (used as unique ID)

* smsServer : the phone number you want to send data to when smsMonitoring is true

* authorizedNumbers : phone numbers which can send command to the sensor

* smsMonitoring : true = send data by TCP + SMS, false = only TCP

* PIN :

	The PIN number of the SIM card.


## Commands

6brain not only pushed the data, it can respond to sms stimuli:

- `status` send back a message with the current status
- `ip` sends back the ip
- `openTunnel:2222:9632:kerrigan` opens a reverse ssh tunnel toward `kerrigan` (must be set in `~/.ssh/config`) and send a message once the tunnel is up.


## Dockerizing

You can run everything in a container if you like. **Careful the image is build for arm7 devices.**

```
docker build -t=ants/6brain:v1 .
docker run -d --restart=always --privileged --net=host -v /dev:/dev ants/6brain:v1
```