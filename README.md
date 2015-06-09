# 6brain

6brain is the core of the 6element sensors. It is responsible for data collection and transmission. It depense on [6sense](https://github.com/anthill/6sense) for data collection and [quipu](https://github.com/anthill/quipu) for transmission through sms.

Juste use `node index.js` to start everything. You should have file called `numbers.json` with:

```
{"serverNumber": "336xxxxxxxx"}
```

where `serverNumber` is the the destination phone number of your server.

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