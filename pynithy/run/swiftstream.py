#!/usr/local/bin/python 

from minio import Minio
from minio.error import S3Error
from swift_stream_service import SwiftStreamService

swiftStreamClient = SwiftStreamService("docker:9000", "swiftstreamadmin", "swiftstreamadmin")

swiftStreamClient.create_bucket("etny-pynithy-v2")

swiftStreamClient.upload_file("etny-pynithy-v2", ".env", "./.env")

print(swiftStreamClient.is_object_in_bucket("etny-pynithy-v2", ".env"))

status, content = swiftStreamClient.get_file_content("etny-pynithy-v2", ".env")

print("************************")
print("Status %s" % status )
print("Content %s" % content)
print("************************")

status, content = swiftStreamClient.get_file_content_bytes("etny-pynithy-v2", ".env")

print("************************")
print("Status %s" % status )
print("Content %s" % content)
print("************************")

