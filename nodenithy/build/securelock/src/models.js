class Order {
    constructor(req, order_id) {
        this.id = order_id;
        this.do_owner = req[0];
        this.dproc = req[1];
        this.do_req = req[2];
        this.dp_req = req[3];
        this.status = req[4];
    }
}

class MetadataBase {
    constructor(metadata, version) {
        this.metadata = metadata;
        this._version = version;
    }

    get version() {
        return this._version;
    }

    get ipfs_hash() {
        throw new Error("Subclass must implement this method");
    }

    checksum() {
        throw new Error("Subclass must implement this method");
    }
}

class PayloadFactory {
    static create_payload_metadata(metadata) {
        if (metadata.includes(":")) {
            if (metadata.startsWith("v1")) {
                return new PayloadMetadataV1(metadata);
            }
            if (metadata.startsWith("v2")) {
                return new PayloadMetadataV2(metadata);
            }

            if (metadata.startsWith("v3")) {
                return new PayloadMetadataV3(metadata);
            }

            throw new Error("Invalid payload metadata type");
        } else {
            return new PayloadMetadataV0(metadata);
        }
    }
}

class InputFactory {
    static create_input_metadata(metadata) {
        if (metadata.includes(":")) {
            if (metadata.startsWith("v1")) {
                return new InputMetadataV1(metadata);
            }
            if (metadata.startsWith("v2")) {
                return new InputMetadataV2(metadata);
            }
            if (metadata.startsWith("v3")) {
                return new InputMetadataV3(metadata);
            }

            throw new Error("Invalid payload metadata type");
        } else {
            return new InputMetadataV0(metadata);
        }
    }
}

class InputMetadataV0 extends MetadataBase {
    constructor(metadata) {
        super(metadata, "v0");
        this._ipfs_hash = metadata;
    }

    get ipfs_hash() {
        return this._ipfs_hash;
    }

    get checksum() {
        return null;
    }
}

class PayloadMetadataV0 extends MetadataBase {
    constructor(metadata) {
        super(metadata, "v0");
        this._ipfs_hash = metadata;
    }

    get ipfs_hash() {
        return this._ipfs_hash;
    }

    get checksum() {
        return null;
    }
}

class PayloadMetadataV1 extends MetadataBase {
    constructor(metadata) {
        super(metadata, "v1");
        this._checksum = metadata.split(":")[2];
        this._ipfs_hash = metadata.split(":")[1];
    }

    get ipfs_hash() {
        return this._ipfs_hash;
    }

    get checksum() {
        return this._checksum;
    }
}

class InputMetadataV1 extends MetadataBase {
    constructor(metadata) {
        super(metadata, "v1");
        this._checksum = metadata.split(":")[2];
        this._ipfs_hash = metadata.split(":")[1];
    }

    get ipfs_hash() {
        return this._ipfs_hash;
    }

    get checksum() {
        return this._checksum !== "0" ? this._checksum : this._checksum;
    }
}

class PayloadMetadataV2 extends MetadataBase {
    constructor(metadata) {
        super(metadata, "v2");
        this._checksum = metadata.split(":")[2];
        this._ipfs_hash = metadata.split(":")[1];
    }

    get ipfs_hash() {
        return this._ipfs_hash;
    }

    get checksum() {
        return this._checksum;
    }
}

class PayloadMetadataV3 extends MetadataBase {
    constructor(metadata) {
        super(metadata, "v3");
        this._checksum = metadata.split(":")[2];
        this._ipfs_hash = metadata.split(":")[1];
    }

    get ipfs_hash() {
        return this._ipfs_hash;
    }

    get checksum() {
        return this._checksum;
    }
}

class InputMetadataV2 extends MetadataBase {
    constructor(metadata) {
        super(metadata, "v2");
        this._checksum = metadata.split(":")[2];
        this._ipfs_hash = metadata.split(":")[1];
    }

    get ipfs_hash() {
        return this._ipfs_hash;
    }

    get checksum() {
        return this._checksum !== "0" ? this._checksum : this._checksum;
    }
}

class InputMetadataV3 extends MetadataBase {
    constructor(metadata) {
        super(metadata, "v3");
        this._checksum = metadata.split(":")[2];
        this._ipfs_hash = metadata.split(":")[1];
    }

    get ipfs_hash() {
        return this._ipfs_hash;
    }

    get checksum() {
        return this._checksum !== "0" ? this._checksum : this._checksum;
    }
}

class DOReqMetadata {
    constructor(req, do_req) {
        this._do_req_id = do_req;
        this._do_owner = req[0];
        this._metadata1 = req[1];
        this._metadata2 = req[2];
        this._metadata3 = req[3];
        this._metadata4 = req[4];
        this._payload_metadata_obj = PayloadFactory.create_payload_metadata(this.payload_metadata);
        this._input_metadata_obj = InputFactory.create_input_metadata(this.input_metadata);
    }

    get do_req_id() {
        return this._do_req_id;
    }

    get do_owner() {
        return this._do_owner;
    }

    get image_metadata() {
        return this._metadata1;
    }

    get public_key() {
        return this.image_metadata.split(':')[5];
    }

    get image_hash() {
        return this.image_metadata.split(':')[1];
    }

    get payload_metadata() {
        return this._metadata2;
    }

    get payload_metadata_obj() {
        return this._payload_metadata_obj;
    }

    get input_metadata_obj() {
        return this._input_metadata_obj;
    }

    get input_metadata() {
        return this._metadata3;
    }

    get node_address() {
        return this._metadata4;
    }
}

module.exports = {
    Order,
    MetadataBase,
    PayloadFactory,
    InputFactory,
    InputMetadataV0,
    PayloadMetadataV0,
    InputMetadataV1,
    PayloadMetadataV1,
    DOReqMetadata
}
