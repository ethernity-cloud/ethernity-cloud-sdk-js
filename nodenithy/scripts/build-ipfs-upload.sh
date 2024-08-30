#!/bin/sh

apk add screen

cd /
wget https://github.com/ipfs/kubo/releases/download/v0.17.0/kubo_v0.17.0_linux-386.tar.gz
tar zxvf kubo_v0.17.0_linux-386.tar.gz
mv kubo go-ipfs
cd go-ipfs
./ipfs init

screen -dm -t ipfs-swarm watch /go-ipfs/ipfs swarm connect /ip4/31.7.188.59/tcp/4001/p2p/QmRBc1eBt4hpJQUqHqn6eA8ixQPD3LFcUDsn6coKBQtia5

screen -dm -t ipfs-daemon /ipfs-daemon.sh

sleep 10

cd /var/lib/registry
HASH=`/go-ipfs/ipfs add . -r | grep added | tail -1 | awk '{print $2}'`
/go-ipfs/ipfs pin add ${HASH}


echo "HASH is ${HASH}"
