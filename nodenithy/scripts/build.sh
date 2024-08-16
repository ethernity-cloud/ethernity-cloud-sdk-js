#!/bin/bash
source ./.env

echo "Building $VERSION"

cd $VERSION/build

docker login registry.scontain.com:5050 -u ${SCONTAIN_LOGIN} -p ${SCONTAIN_PASS}

docker stop $(docker ps -q)
docker rm $(docker ps -q) -f
docker rmi $(docker images -q) -f
docker system prune -f

docker pull registry:2
docker run -d --restart=always -p 5000:5000 --name registry registry:2
docker build -t etny-nodenithy:latest .
docker tag etny-nodenithy localhost:5000/etny-nodenithy
docker push localhost:5000/etny-nodenithy

cd las
docker build -t etny-las .
docker tag etny-las localhost:5000/etny-las
docker push localhost:5000/etny-las

cd ..
docker cp ../../scripts/build-ipfs-upload.sh registry:/
docker cp ../../scripts/ipfs-daemon.sh registry:/

HASH=`docker exec -it registry /build-ipfs-upload.sh | grep "HASH is" | awk '{print $3}' | tr -d '\r'`

echo Following hash was pinned: ${HASH}

git pull
cd ../..
touch hashes/${HASH}
git add hashes/*

git commit -a -m "Added hash ${HASH}"
git push
