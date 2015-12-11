#!/bin/sh

# Initialize network interfaces

# Delete wifi
cat /etc/network/interfaces | \
grep -v wlan | \
grep -v wpa \
> interfaces.tmp && \
sudo mv interfaces.tmp /etc/network/interfaces;

# Set static mode
cat /etc/network/interfaces | \
sed 's/iface eth0 inet \(dhcp\|manual\)/auto eth0\niface eth0 inet static \naddress 192.168.20.35 \nnetmask 255.255.255.0 \nnetwork 192.168.20.0 \nbroadcast 129.168.20.255 \ngateway 192.168.20.1 \n/' \
> interfaces.tmp && \
sudo mv interfaces.tmp /etc/network/interfaces