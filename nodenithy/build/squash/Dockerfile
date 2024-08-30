FROM etny-nodenithy:latest as initial

FROM scratch

COPY --from=initial / /

ENTRYPOINT ["/usr/local/bin/node", "/etny_results.js"]
