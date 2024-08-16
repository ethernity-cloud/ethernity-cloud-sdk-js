const Minio = require('minio');
const fs = require("fs");
class SwiftStreamService {
    constructor(endpoint, port, accessKey, secretKey) {
        this.client = new Minio.Client({
            endPoint: endpoint,
            port: port,
            accessKey: accessKey,
            secretKey: secretKey,
            useSSL: false,
        });
    }

    createBucket(bucketName) {
        return new Promise((resolve, reject) => {
            this.client.bucketExists(bucketName, (err, exists) => {
                if (err) {
                    return reject(err);
                }

                if (!exists) {
                    this.client.makeBucket(bucketName, (err) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(`Bucket ${bucketName} successfully created!`);
                        }
                    });
                } else {
                    resolve(`Bucket ${bucketName} already exists!`);
                }
            });
        });
    }

    getFileContentBytes(bucketName, fileName) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            this.client.getObject(bucketName, fileName, (err, dataStream) => {
                if (err) {
                    return reject(err);
                }

                dataStream.on('data', (chunk) => {
                    chunks.push(chunk);
                });

                dataStream.on('end', () => {
                    const fileData = Buffer.concat(chunks);
                    resolve(fileData);
                });

                dataStream.on('error', (err) => {
                    reject(err);
                });
            });
        });
    }

    getFileContent(bucketName, fileName) {
        return this.getFileContentBytes(bucketName, fileName)
            .then((fileData) => {
                return fileData.toString('utf-8');
            })
            .catch((err) => {
                throw err;
            });
    }

    putFileContent(bucketName, objectName, objectPath, objectData = null) {
        return new Promise((resolve, reject) => {
            this.client.bucketExists(bucketName, (err, exists) => {
                if (err) {
                    return reject(err);
                }

                if (!exists) {
                    this.createBucket(bucketName)
                        .then(() => {
                            if (objectData) {
                                this.client.putObject(bucketName, objectName, objectData, (err) => {
                                    if (err) {
                                        reject(err);
                                    } else {
                                        resolve(`${objectName} is successfully uploaded to bucket ${bucketName}.`);
                                    }
                                });
                            } else {
                                const fileStat = fs.statSync(objectPath);
                                const fileStream = fs.createReadStream(objectPath);

                                this.client.putObject(bucketName, objectName, fileStream, fileStat.size, (err) => {
                                    if (err) {
                                        reject(err);
                                    } else {
                                        resolve(`${objectName} is successfully uploaded to bucket ${bucketName}.`);
                                    }
                                });
                            }
                        })
                        .catch((err) => {
                            reject(err);
                        });
                } else {
                    if (objectData) {
                        this.client.putObject(bucketName, objectName, objectData, (err) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(`${objectName} is successfully uploaded to bucket ${bucketName}.`);
                            }
                        });
                    } else {
                        const fileStat = fs.statSync(objectPath);
                        const fileStream = fs.createReadStream(objectPath);

                        this.client.putObject(bucketName, objectName, fileStream, fileStat.size, (err) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(`${objectName} is successfully uploaded to bucket ${bucketName}.`);
                            }
                        });
                    }
                }
            });
        });
    }

    isObjectInBucket(bucketName, objectName) {
        return new Promise((resolve, reject) => {
            this.client.statObject(bucketName, objectName, (err, stat) => {
                if (err && err.code === 'NotFound') {
                    resolve([stat, false]);
                } else if (err) {
                    reject(err);
                } else {
                    // resolve(`Object ${objectName} exists inside ${bucketName}.`);
                    resolve([stat, true]);
                }
            });
        });
    }

}

module.exports = SwiftStreamService;
