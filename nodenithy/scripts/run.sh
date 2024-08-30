#!/bin/bash

source ./.env

apt-get install -y screen
cd ${VERSION}/run


wget https://github.com/ipfs/kubo/releases/download/v0.17.0/kubo_v0.17.0_linux-386.tar.gz
tar zxvf kubo_v0.17.0_linux-386.tar.gz
rm -rf kubo_v0.17.0_linux-386.tar.gz

mv kubo go-ipfs
cd go-ipfs
./ipfs init

screen -dm -t ipfs-daemon ./ipfs daemon
screen -dm -t ipfs-swarm watch ./ipfs swarm connect /ip4/31.7.188.59/tcp/4001/p2p/QmRBc1eBt4hpJQUqHqn6eA8ixQPD3LFcUDsn6coKBQtia5

cd ..
go-ipfs/ipfs get ${TEMPLATE}

docker-compose down
docker stop registry
docker rm registry
docker rmi localhost:5000/etny-nodenithy
docker rmi localhost:5000/etny-las
docker system prune -f
docker run -d --restart=always -p 5000:5000 --name registry -v  ./${TEMPLATE}:/var/lib/registry registry:2

killall -9 screen
rm -rf go-ipfs

sleep 10

MRENCLAVE=`docker-compose run -e SCONE_LOG=INFO -e SCONE_HASH=1 etny-nodenithy | grep -v Creating | grep -v Pulling | grep -v latest | grep -v Digest | tr -d '\r'`
PREDECESSOR=`cat predecessor.json | grep hash | awk -F '"' '{print $4}'`

cat etny-nodenithy-test-0.0.2.yaml.tpl | sed s/"__PREDECESSOR__"/${PREDECESSOR}/ | sed s/"__MRENCLAVE__"/${MRENCLAVE}/ > etny-nodenithy-test-0.0.2.yaml

curl -k -s --cert certs/cert.pem --key certs/key.pem --data-binary @etny-nodenithy-test-0.0.2.yaml -X POST https://scone-cas.cf:8081/session -v -o predecessor.json


git commit -a -m "Updated for MRENCLAVE: ${MRENCLAVE}"
git push

docker-compose up -d las
docker-compose up etny-nodenithy


