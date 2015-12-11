#!/bin/sh

# This script set the eth0 connection in DHCP mode

cat /etc/network/interfaces | \
sed \
-e 's/eth0 inet static/eth0 inet dhcp/' \
-e 's/^address/#address/' \
-e 's/^netmask/#netmask/' \
-e 's/^network/#network/' \
-e 's/^broadcast/#broadcast/' \
-e 's/^gateway/#gateway/' \
> interfaces.tmp && \
sudo reboot
sudo mv interfaces.tmp /etc/network/interfaces