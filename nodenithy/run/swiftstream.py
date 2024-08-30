#!/usr/local/bin/python

from minio import Minio
from minio.error import S3Error
from swift_stream_service import SwiftStreamService

try:
    print("*********************")
    print("Initializing SwiftStream Service from python...")
    swiftStreamClient = SwiftStreamService("docker:9000", "swiftstreamadmin", "swiftstreamadmin")
    print("Initialized SwiftStream Service successfully")
    print("*********************")
    swiftStreamClient.create_bucket("etny-nodenithy-v3")

    swiftStreamClient.upload_file("etny-nodenithy-v3", ".env", "./.env")

    print(swiftStreamClient.is_object_in_bucket("etny-nodenithy-v3", ".env"))

    status, content = swiftStreamClient.get_file_content("etny-nodenithy-v3", ".env")

    print("************************")
    print("Status %s" % status )
    print("Content %s" % content)
    print("************************")

    status, content = swiftStreamClient.get_file_content_bytes("etny-nodenithy-v3", ".env")

    print("************************")
    print("Status %s" % status )
    print("Content %s" % content)
    print("************************")
except:
    print("An exception occurred")
