FROM registry.scontain.com:5050/sconecuratedimages/services:las as initial

FROM scratch

COPY --from=initial / /

RUN apt-get update
RUN apt-get install psmisc

COPY src/* /

