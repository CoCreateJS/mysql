import {
    ObjectId,
    dotNotationToObject,
    searchData,
    isValidDate
} from "@cocreate/utils";

import { 
    dbClient, 
    createData,
    errorHandler 
} from "./utilities.js";

/**
 * "database" operations mapped to SQL Catalogs.
 */
function database(method, data) {
    const storageName = data.storageConfig?.name;
    return new Promise(
        async (resolve, reject) => {
            let type = "database";
            let databaseArray = [];

            try {
                const pool = await dbClient(data);
                if (!pool || pool.status === false) return resolve(data);

                if (method === "read") {
                    const sql = "SHOW DATABASES;";
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
                        // mysql2 SHOW DATABASES returns key mapping dynamically e.g. "Database"
                        const dbName = row.Database || row.database || Object.values(row)[0];
                        const dbObj = { name: dbName };

                        if (data.filter && data.filter.query) {
                            let isFilter = queryData(dbObj, data.filter.query);
                            if (isFilter) {
                                databaseArray.push({
                                    database: dbObj,
                                    storage: storageName
                                });
                            }
                        } else {
                            databaseArray.push({
                                database: dbObj,
                                storage: storageName
                            });
                        }
                    }
                    resolve(createData(data, databaseArray, type));
                }
                if (method === "delete") {
                    const dbName = data.database;
                    // Sanitize database name targeting raw drop command safely
                    const sql = `DROP DATABASE IF EXISTS \`${dbName.replace(/`/g, "")}\`;`;
                    process.emit("usage", {
                        type: "egress",
                        data: { sql },
                        organization_id: data.organization_id
                    });

                    const [result] = await pool.query(sql);
                    process.emit("usage", {
                        type: "ingress",
                        data: result,
                        organization_id: data.organization_id
                    });
                    resolve({ status: true });
                }
            } catch (error) {
                errorHandler(data, error);
                console.log(method, "error", error);
                resolve(data);
            }
        }
    );
}

export default database