#!/bin/sh

# This script set the eth0 connection in STATIC mode

cat /etc/network/interfaces | \
sed \
-e 's/eth0 inet dhcp/auto eth0\n eth0 inet static/' \
-e 's/#address/address/' \
-e 's/#netmask/netmask/' \
-e 's/#network/network/' \
-e 's/#broadcast/broadcast/' \
-e 's/#gateway/gateway/' \
> interfaces.tmp && \
sudo mv interfaces.tmp /etc/network/interfaces
sudo reboot