#!/bin/sh
source .env

if [ ${SERVICE_TYPE} == "Nodenithy" ]; then
    echo "Adding prerequisites for Nodenithy..."
    ./node_modules/ethernity-cloud-sdk-js/nodenithy/build.sh
elif [ ${SERVICE_TYPE} == "Pynithy" ]; then
    echo "Adding prerequisites for Pynithy..."
else
    echo "Somehthing went wrong"
    exit 1
fi