from __future__ import annotations


class metadataFormatV1:

    def __init__(self, version, content_hash, yaml_hash, challenge_hash) -> None:
        self.version = version
        self.content_hash = content_hash
        self.yaml_hash = yaml_hash
        self.challenge_hash = challenge_hash

    @classmethod
    def from_string(cls, formatted_string) -> metadataFormatV1:
        version, content_hash, yaml_hash, challenge_hash = formatted_string.split(':')
        return metadataFormatV1(
            version=version,
            content_hash=content_hash,
            yaml_hash=yaml_hash,
            challenge_hash=challenge_hash,
        )

    @classmethod
    def to_string(cls, classObject=None) -> str:
        return classObject

    def __str__(self) -> str:
        return f"{self.version}:{self.content_hash}:{self.yaml_hash}:{self.challenge_hash}"


if __name__ == '__main__':
    from_string = metadataFormatV1.from_string('v1:<dockerRegistryContentHash>:<containerConfigYamlHash>:<hash>')
    print('-------from string')
    print(f'''
        version = {from_string.version},
        content_hash = {from_string.content_hash},
        yaml_hash = {from_string.yaml_hash},
        challenge_hash = {from_string.challenge_hash},
    ''')

    print('-------to string')
    to_string = metadataFormatV1.to_string(from_string)
    print(to_string)
