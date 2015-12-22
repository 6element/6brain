# 6brain

6brain is the core of the 6element sensors. It is responsible for data collection and transmission. It dependes on 
[6sense](https://github.com/anthill/6sense) for affluence data collection.
[6bin](https://github.com/anthill/6bin) for user interface 

Juste use `node index.js` to start everything. You should create a file called `PRIVATE.json` with this pattern:

```
{
        "mqttToken": "zzzzzz", #token for mqtt auth
        "id": "xxxxxxxxx", #id for auth
        "host":"xx.xx.xx.xx", #ip address of mqtt broker
        "port":... #for mqtt,
        "PIN": 0000
}
```



## Commands

6brain not only push datas, it can respond to MQTT stimuli:

[Here](https://github.com/anthill/pheromon/blob/master/api/clients/Admin/ReadMe.md) is a list of all commands supported.
