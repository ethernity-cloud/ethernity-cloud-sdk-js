#!/bin/bash

set -e

SOCKET="/var/run/aesmd/aesm.socket"

# Try to connect to the socket
# Previously we merely checked that the socket file exists. However, the
# file is not removed when the container stops and, thus, when we restart
# the file still exists and we assume that we are supposed to use an
# outside AESM.
if socat -u OPEN:/dev/null UNIX-CONNECT:${SOCKET}; then
    # An AESM socket was already mounted into the container, don't start a local AESM service, start LAS directly
    echo "${SOCKET} exists - Will use mounted AESM socket; the local in-container AESM service will not be started!"
    exec "$@"
else
    # No AESM socket present, delegate execution to the local AESM service
    echo "${SOCKET} not found or unable to connect - Starting local in-container AESM service"
    if [ -e ${SOCKET} ]; then
        # Ensure the socket file does not exist - AESM won't start if it does...
        rm ${SOCKET}
    fi
    exec /entrypoint.sh "$@"
fi

/etny_entrypoint.sh &
