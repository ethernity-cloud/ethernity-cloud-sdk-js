FROM registry.scontain.com:5050/ethernity/node:16.13.1-alpine3.15-scone5.8-production as release

RUN apk update

RUN cd /

RUN apk add bash

ENV SCONE_MODE=SIM
ENV SCONE_HEAP=256M
ENV SCONE_LOG=DEBUG

RUN mkdir binary-fs-dir

COPY src/* /etny-trustedzone/
COPY scripts/* /etny-trustedzone/
COPY src/trustedzone.js /etny-trustedzone/trustedzone.py

WORKDIR /etny-trustedzone
RUN pwd
RUN npm install
RUN ls

WORKDIR /

RUN ["chmod", "+x", "etny-trustedzone/binary-fs-build.sh"]
RUN etny-trustedzone/binary-fs-build.sh

FROM registry.scontain.com:5050/sconecuratedimages/crosscompilers as build

COPY --from=release /binary-fs-dir /.

RUN scone gcc ./binary_fs_blob.s ./libbinary_fs_template.a -shared -o /libbinary-fs.so

#
FROM registry.scontain.com:5050/ethernity/node:16.13.1-alpine3.15-scone5.8-production

COPY --from=build /libbinary-fs.so /lib/libbinary-fs.so
#

RUN apk update

RUN apk add openssl

RUN openssl genrsa -3 -out /enclave-key.pem 3072

ENV SCONE_LOG=info
ENV SCONE_HEAP=256M
ENV SCONE_ALLOW_DLOPEN=1
ENV SCONE_EXTENSIONS_PATH=/lib/libbinary-fs.so

RUN cp /usr/local/bin/node /usr/local/bin/python3
RUN scone-signer sign --key=/enclave-key.pem --env --production /usr/bin/node
RUN rm -rf /enclave-key.pem

#RUN scone cas attest scone-cas.cf 3061b9feb7fa67f3815336a085f629a13f04b0a1667c93b14ff35581dc8271e4 -GCS --only_for_testing-debug --only_for_testing-ignore-signer
RUN ls /usr/local/bin
ENTRYPOINT ["/usr/local/bin/node", "/etny-trustedzone/trustedzone.js"]
