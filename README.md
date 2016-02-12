# 6brain

6brain is the core of the 6element sensors. It is responsible for data collection and transmission. It dependes on 
[6sense](https://github.com/anthill/6sense) for affluence data collection.
[6bin](https://github.com/anthill/6bin) for user interface 

Juste use `node index.js` to start everything.

You need to create the `PRIVATE` folder, and a file `PRIVATE/common.json` with this pattern:

```
{
        "mqttToken": "zzzzzz", // token for mqtt auth
        "host":"xx.xx.xx.xx", // ip address of mqtt broker
        "port":... //for mqtt,
        "binSource": "myBinSource",
        "sixElementToken": "zzzzzzzzzzzzz" // token for 6element access 
}
```


The `id` is located in `PRIVATE/id.json`, which is automatically created on first boot.

## Commands

6brain not only push datas, it can respond to MQTT stimuli:

[Here](https://github.com/anthill/pheromon/blob/master/api/clients/Admin/ReadMe.md) is a list of all commands supported.
