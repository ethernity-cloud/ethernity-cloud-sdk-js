
#!/bin/bash

( tail -f -n0 /var/log/las.log & ) | grep -q "Sign request failed with Enclave lost after power transition or used in child process created by"

killall -9 las
