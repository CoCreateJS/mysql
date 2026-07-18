const mysql = require("mysql2/promise");
const {
	dotNotationToObject,
	queryData,
	searchData,
	sortData,
	isValidDate
} = require("@cocreate/utils");

const organizations = {};

/**
 * Dynamically resolves or caches a long-lived MySQL/MariaDB Connection Pool.
 * Caches the connection promise to prevent concurrent, duplicate handshakes.
 */
async function dbClient(data) {
	if (data.storageUrl) {
		if (!organizations[data.organization_id]) {
			organizations[data.organization_id] = {};
		}
		try {
			if (!organizations[data.organization_id][data.storageUrl]) {
				// Establish connection pool using the provided URL
				// mysql2 natively parses URIs like mysql://user:pass@host:port/database
				const poolPromise = (async () => {
					const pool = mysql.createPool({
						uri: data.storageUrl,
						connectionLimit: 10,
						idleTimeout: 30000,
						connectTimeout: 5000,
						enableKeepAlive: true,
						keepAliveInitialDelay: 10000
					});
					// Test connection immediately to fail early if credentials/host are invalid
					const connection = await pool.getConnection();
					connection.release();
					return pool;
				})();

				organizations[data.organization_id][data.storageUrl] = poolPromise;
			}
			
			// Await connection resolution safely
			return await organizations[data.organization_id][data.storageUrl];
		} catch (error) {
			console.error(
				`${data.organization_id}: storageUrl ${data.storageUrl} failed to connect to MySQL/MariaDB`
			);
			errorHandler(data, error);
			return { status: false };
		}
	}

	errorHandler(data, "missing StorageUrl");
	return;
}

/**
 * Global Event Listener: orgDeleted
 * Gracefully terminates active MySQL/MariaDB connection pools.
 * Initiates a 5-second grace period for pending async operations to resolve.
 */
process.on("orgDeleted", (organization_id) => {
	const orgPools = organizations[organization_id];
	if (orgPools) {
		console.log(`[MySQL Utilities] Cleanup Scheduled: Initiating 5-second grace period for Org: ${organization_id}`);
		setTimeout(async () => {
			const currentPools = organizations[organization_id];
			if (!currentPools) return;

			console.log(`[MySQL Utilities] Cleanup Executing: Closing connection pools for Org: ${organization_id}`);
			const poolPromises = Object.values(currentPools);

			for (const poolPromise of poolPromises) {
				try {
					const pool = await poolPromise;
					if (pool && typeof pool.end === "function") {
						await pool.end();
					}
				} catch (err) {
					console.error(`[MySQL Utilities] Error closing connection pool for Org ${organization_id}:`, err);
				}
			}

			delete organizations[organization_id];
			console.log(`[MySQL Utilities] Memory Cleared: Registry freed for Org: ${organization_id}`);
		}, 5000);
	}
});

/**
 * Universal router routing request methods safely.
 */
function send(data) {
	let [type, method] = data.method.split(".");
	if (type === "database") return database(method, data);
	if (type === "array") return array(method, data);
	if (type === "object") return object(method, data);
}

/**
 * "database" operations mapped to SQL Catalogs.
 */
function database(method, data) {
	return new Promise(
		async (resolve, reject) => {
			let type = "database";
			let databaseArray = [];

			try {
				const pool = await dbClient(data);
				if (!pool || pool.status === false) return data;

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

						if (data.$filter && data.$filter.query) {
							let isFilter = queryData(dbObj, data.$filter.query);
							if (isFilter) {
								databaseArray.push({
									database: dbObj,
									storage: data.storageName
								});
							}
						} else {
							databaseArray.push({
								database: dbObj,
								storage: data.storageName
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
		},
		(error) => {
			errorHandler(data, error);
		}
	);
}

/**
 * "array" operations mapped to SQL Tables.
 */
function array(method, data) {
	return new Promise(
		async (resolve, reject) => {
			let type = "array";
			let arrayArray = [];

			try {
				const pool = await dbClient(data);
				if (!pool || pool.status === false) return data;

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

							if (data.$filter && data.$filter.query) {
								let isFilter = queryData(tableObj, data.$filter.query);
								if (isFilter) {
									arrayArray.push({
										name: tableName,
										database,
										storage: data.storageName
									});
								}
							} else {
								arrayArray.push({
									name: tableName,
									database,
									storage: data.storageName
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
									storage: data.storageName
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
										storage: data.storageName
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
										storage: data.storageName
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
		},
		(error) => {
			errorHandler(data, error);
		}
	);
}

/**
 * "object" operations mapped to SQL Rows.
 */
function object(method, data) {
	return new Promise(
		async (resolve, reject) => {
			try {
				const pool = await dbClient(data);
				if (!pool || pool.status === false) return data;

				let type = "object";
				let documents = [];

				if (!data["timeStamp"]) {
					data["timeStamp"] = new Date().toISOString();
				}

				let databases = data.database;
				if (!Array.isArray(databases)) databases = [databases];

				for (let database of databases) {
					let arrays = data.array;
					if (!Array.isArray(arrays)) arrays = [arrays];

					for (let array of arrays) {
						const reference = {
							$storage: data.storageName,
							$database: database,
							$array: array
						};

						if (!data[type]) data[type] = [];
						else if (typeof data[type] === "string")
							data[type] = [{ _id: data[type] }];
						else if (!Array.isArray(data[type]))
							data[type] = [data[type]];

						let isFilter = !!data.$filter;
						if ((isFilter && !data[type].length) || data.isFilter) {
							data[type].splice(0, 0, { isFilter: "isEmptyObjectFilter" });
						}

						for (let i = 0; i < data[type].length; i++) {
							let $storage = data[type][i].$storage || [];
							let $database = data[type][i].$database || [];
							let $array = data[type][i].$array || [];

							if (!Array.isArray($storage)) $storage = [data[type][i].$storage];
							if (!Array.isArray($database)) $database = [data[type][i].$database];
							if (!Array.isArray($array)) $array = [data[type][i].$array];

							if (!$storage.includes(data.storageName)) $storage.push(data.storageName);
							if (!$database.includes(database)) $database.push(database);
							if (!$array.includes(array)) $array.push(array);

							delete data[type][i].$storage;
							delete data[type][i].$database;
							delete data[type][i].$array;

							let queryFilter = isFilter ? data.$filter : (data[type][i].$filter || null);
							let { sqlWhere, params } = compileFilterToSQL(queryFilter, data.organization_id);

							if (method === "create") {
								data[type][i] = replaceArray(data[type][i]);
								data[type][i] = dotNotationToObject(data[type][i]);

								const id = data[type][i]._id || `row_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
								const orgId = data.organization_id;
								const created = {
									on: new Date(data.timeStamp),
									by: data.user_id || data.clientId
								};

								const recordPayload = { ...data[type][i] };
								delete recordPayload._id;
								delete recordPayload.organization_id;

								const sql = `
									INSERT INTO \`${array.replace(/`/g, "")}\` (_id, organization_id, data, created, modified)
									VALUES (?, ?, ?, ?, NULL);
								`;
								const queryParams = [id, orgId, JSON.stringify(recordPayload), JSON.stringify(created)];

								process.emit("usage", {
									type: "egress",
									data: { sql, queryParams },
									organization_id: data.organization_id
								});

								await pool.query(sql, queryParams);

								const selectSql = `SELECT * FROM \`${array.replace(/`/g, "")}\` WHERE _id = ? AND organization_id = ?`;
								const [createdDocs] = await pool.query(selectSql, [id, orgId]);
								if (createdDocs.length > 0) {
									const formattedDoc = parseSqlRow(createdDocs[0]);
									data[type][i] = { ...formattedDoc, $storage, $database, $array };
								}
							}
							else if (method === "read") {
								let sql = `SELECT * FROM \`${array.replace(/`/g, "")}\` ${sqlWhere}`;

								if (data.$filter && data.$filter.sort) {
									const sortClauses = data.$filter.sort.map(s => {
										let dir = s.direction === -1 || s.direction === "desc" ? "DESC" : "ASC";
										if (["_id", "organization_id"].includes(s.key)) {
											return `\`${s.key}\` ${dir}`;
										}
										return `JSON_UNQUOTE(JSON_EXTRACT(data, '$.${s.key}')) ${dir}`;
									});
									sql += ` ORDER BY ${sortClauses.join(", ")}`;
								}
								if (data.$filter && typeof data.$filter.limit === "number") {
									sql += ` LIMIT ${data.$filter.limit}`;
								}
								if (data.$filter && typeof data.$filter.index === "number") {
									sql += ` OFFSET ${data.$filter.index}`;
								}

								if (data[type][i]._id && !isFilter) {
									sql = `SELECT * FROM \`${array.replace(/`/g, "")}\` WHERE _id = ? AND organization_id = ?`;
									params = [data[type][i]._id, data.organization_id];
								}

								process.emit("usage", {
									type: "egress",
									data: { sql, params },
									organization_id: data.organization_id
								});

								const [rows] = await pool.query(sql, params);
								process.emit("usage", {
									type: "ingress",
									data: rows,
									organization_id: data.organization_id
								});

								if (isFilter) {
									for (let row of rows) {
										const parsedRow = parseSqlRow(row);
										if (data.$filter && data.$filter.search) {
											let isMatch = searchData(parsedRow, data.$filter.search);
											if (!isMatch) continue;
										}
										documents.push({
											...parsedRow,
											...reference
										});
									}
								} else if (rows.length > 0) {
									let dbRecord = parseSqlRow(rows[0]);

									// Offline timing merge synchronization
									if ($storage.length && data[type][i].modified && data[type][i].modified.on) {
										let clientTime = new Date(data[type][i].modified.on);
										let dbTime = new Date(dbRecord.modified ? dbRecord.modified.on : 0);

										if (clientTime > dbTime) {
											const updatedRecord = { ...dbRecord, ...data[type][i] };
											const savedRecord = await executeUpdateTransaction(pool, array, data[type][i]._id, updatedRecord, data);
											data[type][i] = { ...savedRecord, $storage, $database, $array };
										} else {
											data[type][i] = { ...data[type][i], ...dbRecord, $storage, $database, $array };
										}
									} else {
										data[type][i] = {
											...data[type][i],
											...dbRecord,
											$storage, $database, $array
										};
									}
								} else {
									data[type].splice(i, 1);
									i--;
								}
							}
							else if (method === "update") {
								const updatePayload = { ...data[type][i] };
								delete updatePayload._id;
								delete updatePayload.$filter;

								if (data[type][i]._id) {
									const updatedDoc = await executeUpdateTransaction(pool, array, data[type][i]._id, updatePayload, data);
									if (updatedDoc) {
										data[type][i] = { ...updatedDoc, $storage, $database, $array };
									}
								} else if (isFilter) {
									const selectSql = `SELECT _id FROM \`${array.replace(/`/g, "")}\` ${sqlWhere}`;
									process.emit("usage", {
										type: "egress",
										data: { selectSql, params },
										organization_id: data.organization_id
									});
									const [selectRows] = await pool.query(selectSql, params);

									for (let row of selectRows) {
										const updatedDoc = await executeUpdateTransaction(pool, array, row._id, updatePayload, data);
										if (updatedDoc) {
											documents.push({ ...updatedDoc, ...reference });
										}
									}
								}
							}
							else if (method === "delete") {
								let sql, queryParams;
								if (data[type][i]._id) {
									sql = `DELETE FROM \`${array.replace(/`/g, "")}\` WHERE _id = ? AND organization_id = ?;`;
									queryParams = [data[type][i]._id, data.organization_id];
								} else if (isFilter) {
									sql = `DELETE FROM \`${array.replace(/`/g, "")}\` ${sqlWhere};`;
									queryParams = params;
								}

								if (sql) {
									process.emit("usage", {
										type: "egress",
										data: { sql, queryParams },
										organization_id: data.organization_id
									});
									const [runResult] = await pool.query(sql, queryParams);
									process.emit("usage", {
										type: "ingress",
										data: runResult,
										organization_id: data.organization_id
									});

									if (isFilter) {
										documents.push({ _id: data[type][i]._id, ...reference });
									} else {
										data[type][i] = { _id: data[type][i]._id, $storage, $database, $array };
									}
								}
							}
						}
					}
				}

				data = createData(data, documents, type);
				resolve(data);
			} catch (error) {
				errorHandler(data, error);
				console.log(method, "error", error);
				resolve(data);
			}
		},
		(error) => {
			errorHandler(data, error);
		}
	);
}

/**
 * Safe transaction helper to update unstructured payloads with MongoDB behavior inside MySQL.
 * Employs row locking 'FOR UPDATE' to eliminate write/concurrency conflicts.
 */
async function executeUpdateTransaction(pool, arrayName, docId, rawUpdateInput, requestData) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();

		const selectSql = `SELECT * FROM \`${arrayName.replace(/`/g, "")}\` WHERE _id = ? AND organization_id = ? FOR UPDATE;`;
		const [selectRows] = await connection.query(selectSql, [docId, requestData.organization_id]);
		let currentRecord = selectRows.length > 0 ? parseSqlRow(selectRows[0]) : null;

		if (!currentRecord) {
			if (requestData.upsert || rawUpdateInput.upsert || rawUpdateInput.$upsert) {
				currentRecord = { _id: docId, organization_id: requestData.organization_id };
			} else {
				await connection.rollback();
				return null;
			}
		}

		const modified = {
			on: new Date(requestData.timeStamp),
			by: requestData.user_id || requestData.clientId
		};

		const updatedPayload = applyMongoUpdate(currentRecord, rawUpdateInput);

		const savePayload = { ...updatedPayload };
		delete savePayload._id;
		delete savePayload.organization_id;
		delete savePayload.created;
		delete savePayload.modified;

		const updateSql = `
			UPDATE \`${arrayName.replace(/`/g, "")}\`
			SET data = ?,
			    modified = ?
			WHERE _id = ? AND organization_id = ?;
		`;
		const updateParams = [JSON.stringify(savePayload), JSON.stringify(modified), docId, requestData.organization_id];

		process.emit("usage", {
			type: "egress",
			data: { sql: updateSql, updateParams },
			organization_id: requestData.organization_id
		});

		await connection.query(updateSql, updateParams);
		await connection.commit();

		const [finalRecordRaw] = await pool.query(`SELECT * FROM \`${arrayName.replace(/`/g, "")}\` WHERE _id = ? AND organization_id = ?`, [docId, requestData.organization_id]);
		return parseSqlRow(finalRecordRaw[0]);
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

/**
 * Applies MongoDB update operators recursively to maintain unified schema manipulation behaviors.
 */
function applyMongoUpdate(record, updatePayload) {
	let target = { ...record };

	Object.keys(updatePayload).forEach((rawKey) => {
		if (rawKey.startsWith("$")) return;
		let cleanKey = rawKey.replace(/\[(\d+)\]/g, ".$1");
		setNestedValue(target, cleanKey, updatePayload[rawKey]);
	});

	if (updatePayload.$set) {
		Object.keys(updatePayload.$set).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			setNestedValue(target, cleanKey, updatePayload.$set[key]);
		});
	}

	if (updatePayload.$unset) {
		Object.keys(updatePayload.$unset).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			deleteNestedValue(target, cleanKey);
		});
	}

	if (updatePayload.$inc) {
		Object.keys(updatePayload.$inc).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let currentVal = getNestedValue(target, cleanKey) || 0;
			setNestedValue(target, cleanKey, Number(currentVal) + Number(updatePayload.$inc[key]));
		});
	}

	if (updatePayload.$push) {
		Object.keys(updatePayload.$push).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let arr = getNestedValue(target, cleanKey);
			if (!Array.isArray(arr)) arr = [];

			const pushValue = updatePayload.$push[key];
			if (pushValue && pushValue.$each) {
				let valuesToPush = pushValue.$each;
				let position = typeof pushValue.$position === "number" ? pushValue.$position : arr.length;
				arr.splice(position, 0, ...valuesToPush);
			} else {
				arr.push(pushValue);
			}
			setNestedValue(target, cleanKey, arr);
		});
	}

	if (updatePayload.$pull) {
		Object.keys(updatePayload.$pull).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let arr = getNestedValue(target, cleanKey);
			if (Array.isArray(arr)) {
				const filterVal = updatePayload.$pull[key];
				arr = arr.filter(item => {
					if (typeof filterVal === "object" && filterVal !== null) {
						return !queryData(item, filterVal);
					}
					return item !== filterVal;
				});
				setNestedValue(target, cleanKey, arr);
			}
		});
	}

	if (updatePayload.$addToSet) {
		Object.keys(updatePayload.$addToSet).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let arr = getNestedValue(target, cleanKey);
			if (!Array.isArray(arr)) arr = [];

			const addValue = updatePayload.$addToSet[key];
			if (addValue && addValue.$each) {
				addValue.$each.forEach(item => {
					if (!arr.includes(item)) arr.push(item);
				});
			} else {
				if (!arr.includes(addValue)) arr.push(addValue);
			}
			setNestedValue(target, cleanKey, arr);
		});
	}

	return target;
}

/**
 * Translates standard MongoDB JSON filters into native MySQL query filters.
 */
function compileFilterToSQL(filter, organizationId) {
	let clauses = ["organization_id = ?"];
	let params = [organizationId];

	if (filter && filter.query) {
		const parseConditionGroup = (queryObj, isOrJoin = false) => {
			let localClauses = [];

			if (queryObj.$or && Array.isArray(queryObj.$or)) {
				let orClauses = queryObj.$or.map(subQuery => parseConditionGroup(subQuery)).filter(c => c.length);
				if (orClauses.length) {
					localClauses.push("(" + orClauses.join(" OR ") + ")");
				}
			}
			if (queryObj.$and && Array.isArray(queryObj.$and)) {
				let andClauses = queryObj.$and.map(subQuery => parseConditionGroup(subQuery)).filter(c => c.length);
				if (andClauses.length) {
					localClauses.push("(" + andClauses.join(" AND ") + ")");
				}
			}

			for (let key in queryObj) {
				if (["$or", "$and"].includes(key)) continue;

				let value = queryObj[key];
				const targetField = ["_id", "organization_id"].includes(key)
					? `\`${key}\``
					: `JSON_UNQUOTE(JSON_EXTRACT(data, '$.${key}'))`;

				if (value && typeof value === "object" && !Array.isArray(value)) {
					for (let op in value) {
						let operand = value[op];
						params.push(operand);

						if (op === "$gt") localClauses.push(`${targetField} > ?`);
						else if (op === "$gte") localClauses.push(`${targetField} >= ?`);
						else if (op === "$lt") localClauses.push(`${targetField} < ?`);
						else if (op === "$lte") localClauses.push(`${targetField} <= ?`);
						else if (op === "$ne") localClauses.push(`${targetField} != ?`);
						else if (op === "$in") {
							params.pop(); // Remove single item
							const placeholders = operand.map(() => "?").join(", ");
							operand.forEach(o => params.push(o));
							localClauses.push(`${targetField} IN (${placeholders})`);
						}
					}
				} else {
					params.push(value);
					localClauses.push(`${targetField} = ?`);
				}
			}

			return localClauses.join(isOrJoin ? " OR " : " AND ");
		};

		const processedQuery = parseConditionGroup(filter.query);
		if (processedQuery) {
			clauses.push(processedQuery);
		}
	}

	return {
		sqlWhere: clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "",
		params
	};
}

/**
 * Resolves MySQL columns and rows back into unified JSON format.
 */
function parseSqlRow(row) {
	if (!row) return null;
	const recordData = typeof row.data === "string" ? JSON.parse(row.data) : (row.data || {});
	return {
		_id: row._id,
		organization_id: row.organization_id,
		created: typeof row.created === "string" ? JSON.parse(row.created) : row.created,
		modified: typeof row.modified === "string" ? JSON.parse(row.modified) : row.modified,
		...recordData
	};
}

function replaceArray(data = {}) {
	let object = {};
	Object.keys(data).forEach((key) => {
		object[key.replace(/\[(\d+)\]/g, ".$1")] = data[key];
	});
	return object;
}

function getNestedValue(obj, path) {
	return path.split(".").reduce((acc, part) => acc && acc[part], obj);
}

function setNestedValue(obj, path, value) {
	const parts = path.split(".");
	const last = parts.pop();
	const target = parts.reduce((acc, part) => acc[part] = acc[part] || {}, obj);
	target[last] = value;
}

function deleteNestedValue(obj, path) {
	const parts = path.split(".");
	const last = parts.pop();
	const target = parts.reduce((acc, part) => acc && acc[part], obj);
	if (target) delete target[last];
}

/**
 * Syncs the output response data arrays back cleanly.
 */
function createData(data, array, type) {
	if (data[type] && data[type][0] && data[type][0].isFilter === "isEmptyObjectFilter") {
		data[type].shift();
		data.isFilter = true;
	}

	let key = type !== "object" ? "name" : "_id";

	if (!Array.isArray(data[type])) {
		console.log("data[type] is not an array", type);
	} else {
		for (let i = 0; i < array.length; i++) {
			const matchIndex = data[type].findIndex((item) => item[key] === array[i][key]);
			if (matchIndex !== -1) {
				for (let $type of ["$storage", "$database", "$array"]) {
					if (!data[type][matchIndex][$type]) data[type][matchIndex][$type] = [];
					if (!Array.isArray(data[type][matchIndex][$type])) {
						data[type][matchIndex][$type] = [data[type][matchIndex][$type]];
					}
					if (!data[type][matchIndex][$type].includes(array[i][$type])) {
						data[type][matchIndex][$type].push(array[i][$type]);
					}
					delete array[i][$type];
				}
				data[type][matchIndex] = { ...data[type][matchIndex], ...array[i] };
			} else {
				data[type].push(array[i]);
			}
		}
	}
	return data;
}

function errorHandler(data, error, database, array) {
	let errorMessage = typeof error === "object" && error.message ? error.message : error;
	let errorObject = {
		message: errorMessage,
		storage: "mysql"
	};

	if (database) errorObject.database = database;
	if (array) errorObject.array = array;

	if (Array.isArray(data.error)) {
		data.error.push(errorObject);
	} else {
		data.error = [errorObject];
	}
}

module.exports = { send };