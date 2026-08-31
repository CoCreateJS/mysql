import {
    ObjectId,
    dotNotationToObject,
    searchData,
    isValidDate
} from "@cocreate/utils";

import { 
    dbClient, 
    createFilter, 
    createData,
    errorHandler 
} from "./utilities.js";

/**
 * "array" operations mapped to SQL Tables.
 */
function array(method, data) {
    const storageName = data.storageConfig?.name;
    return new Promise(
        async (resolve, reject) => {
            let type = "array";
            let arrayArray = [];

            try {
                const pool = await dbClient(data);
                if (!pool || pool.status === false) return resolve(data);

                if (data.request) data.array = data.request;

                let databases = data.database;
                if (!Array.isArray(databases)) databases = [databases];

                let databasesLength = databases.length;
                for (let database of databases) {
                    if (method === "read") {
                        const sql = "SHOW TABLES;";
                        process.emit("usage", {
                            type: "egress",
                            data: { sql },
                            organization_id: data.organization_id
                        });

                        const [rows] = await pool.query(sql);
                        process.emit("usage", {
                            type: "ingress",
                            data: rows,
                            organization_id: data.organization_id
                        });

                        for (let row of rows) {
                            const tableName = Object.values(row)[0];
                            const tableObj = { name: tableName };

                            if (data.filter && data.filter.query) {
                                let isFilter = queryData(tableObj, data.filter.query);
                                if (isFilter) {
                                    arrayArray.push({
                                        name: tableName,
                                        database,
                                        storage: storageName
                                    });
                                }
                            } else {
                                arrayArray.push({
                                    name: tableName,
                                    database,
                                    storage: storageName
                                });
                            }
                        }

                        databasesLength -= 1;
                        if (!databasesLength) {
                            data = createData(data, arrayArray, type);
                            resolve(data);
                        }
                    } else {
                        let arrays = data.array;
                        if (method === "update") arrays = Object.entries(data.array);
                        if (!Array.isArray(arrays)) arrays = [arrays];

                        let arraysLength = arrays.length;
                        for (let array of arrays) {
                            if (method === "create") {
                                // MySQL requires TEXT/VARCHAR keys and natively stores JSON columns
                                const sql = `
                                    CREATE TABLE IF NOT EXISTS \`${array.replace(/`/g, "")}\` (
                                        _id VARCHAR(50) PRIMARY KEY,
                                        organization_id VARCHAR(50),
                                        data JSON,
                                        created JSON,
                                        modified JSON
                                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
                                `;
                                process.emit("usage", {
                                    type: "egress",
                                    data: { sql },
                                    organization_id: data.organization_id
                                });

                                await pool.query(sql);
                                arrayArray.push({
                                    name: array,
                                    database,
                                    storage: storageName
                                });

                                arraysLength -= 1;
                                if (!arraysLength) databasesLength -= 1;
                                if (!databasesLength && !arraysLength) {
                                    data = createData(data, arrayArray, type);
                                    resolve(data);
                                }
                            } else {
                                if (method === "update") {
                                    let [oldName, newName] = array;
                                    const sql = `ALTER TABLE \`${oldName.replace(/`/g, "")}\` RENAME TO \`${newName.replace(/`/g, "")}\`;`;
                                    process.emit("usage", {
                                        type: "egress",
                                        data: { sql },
                                        organization_id: data.organization_id
                                    });

                                    await pool.query(sql);
                                    arrayArray.push({
                                        name: newName,
                                        oldName: oldName,
                                        database,
                                        storage: storageName
                                    });

                                    arraysLength -= 1;
                                    if (!arraysLength) databasesLength -= 1;
                                    if (!databasesLength && !arraysLength) {
                                        data = createData(data, arrayArray, type);
                                        resolve(data);
                                    }
                                }

                                if (method === "delete") {
                                    const sql = `DROP TABLE IF EXISTS \`${array.replace(/`/g, "")}\`;`;
                                    process.emit("usage", {
                                        type: "egress",
                                        data: { sql },
                                        organization_id: data.organization_id
                                    });

                                    await pool.query(sql);
                                    arrayArray.push({
                                        name: array,
                                        database,
                                        storage: storageName
                                    });

                                    arraysLength -= 1;
                                    if (!arraysLength) databasesLength -= 1;
                                    if (!databasesLength && !arraysLength) {
                                        data = createData(data, arrayArray, type);
                                        resolve(data);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                errorHandler(data, error);
                console.log(method, "error", error);
                resolve(data);
            }
        }
    );
}

export default array