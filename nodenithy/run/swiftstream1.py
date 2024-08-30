#!/usr/local/bin/python

from minio import Minio
from minio.error import S3Error
from swift_stream_service import SwiftStreamService

try:
    print("*********************")
    print("Initializing SwiftStream Service from python...")
    swiftStreamClient = SwiftStreamService("localhost:9000", "swiftstreamadmin", "swiftstreamadmin")
    print("Initialized SwiftStream Service successfully")
    print("*********************")

    status, content = swiftStreamClient.get_file_content("etny-nodenithy-v2", "result11.txt")

    # status, content = swiftStreamClient.get_file_content_bytes("etny-nodenithy-v2", "result11.txt")

    print("************************")
    print("Status %s" % status )
    print("Content %s" % content)
    print("************************")
except Exception as e:
    print("An exception occurred" + str(e))
