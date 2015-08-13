FROM armv7/armhf-archlinux

MAINTAINER Alexandre Vallette <alexandre.vallette@ants.builders>

# nodejs
RUN pacman -Sy --noconfirm
RUN pacman -S --noconfirm nodejs npm python2
RUN cd /usr/bin && ln -sf python2 python
RUN npm install -g forever

# airmon
RUN pacman -S ethtool libnl iw wget base-devel --noconfirm 
RUN wget http://download.aircrack-ng.org/aircrack-ng-1.2-rc2.tar.gz
RUN tar -zxvf aircrack-ng-1.2-rc2.tar.gz
RUN make -C aircrack-ng-1.2-rc2
RUN make install -C aircrack-ng-1.2-rc2
RUN rm aircrack-ng-1.2-rc2.tar.gz
RUN rm -rf aircrack-ng-1.2-rc2
RUN /usr/local/sbin/airodump-ng-oui-update

RUN mkdir /6brain
WORKDIR /6brain

COPY . .
RUN npm install

CMD forever client/client.js
