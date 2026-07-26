import webpack from "webpack";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EsbuildPlugin } from "esbuild-loader";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async (env, argv) => {
    const isProduction = argv && argv.mode === "production";

    const config = {
        // Target Node.js environment for Worker Threads execution
        target: "node",

        // Output native ES Module bundle syntax
        experiments: {
            outputModule: true
        },

        // Entry point for the MySQL database adapter
        entry: {
            "mysql": "./src/index.js"
        },

        output: {
            path: path.resolve(__dirname, "dist"),
            // Produces 'mysql.bundle.js'
            filename: "[name].bundle.js",
            library: {
                type: "module"
            },
            clean: true,
            globalObject: "this"
        },

        resolve: {
            extensions: [".js", ".mjs", ".cjs", ".json"],
            fullySpecified: false
        },

        node: {
            __dirname: false,
            __filename: false
        },

        plugins: [
            // Force Webpack to merge into 1 single bundle file
            new webpack.optimize.LimitChunkCountPlugin({
                maxChunks: 1
            }),

            // Ignore iconv-lite heavy encoding table files (Big5, Shift_JIS, EUC-JP, etc.)
            // mysql2 will fall back to Node.js native C++ Buffer for UTF-8 and standard encodings.
            new webpack.IgnorePlugin({
                resourceRegExp: /^\.\/encodings$/,
                contextRegExp: /iconv-lite$/
            }),

            // Ignore non-essential optional dependencies and binary modules
            new webpack.IgnorePlugin({
                resourceRegExp: /^(aws-sdk|cardinal|tls-psk|@aws-sdk\/.*|\.d\.ts)$/
            })
        ],

        mode: isProduction ? "production" : "development",
        devtool: false,

        module: {
            rules: [
                {
                    test: /\.m?[jc]s$/,
                    type: "javascript/auto",
                    resolve: {
                        fullySpecified: false
                    }
                },
                {
                    test: /\.js$/,
                    exclude: /node_modules/,
                    use: {
                        loader: "esbuild-loader",
                        options: {
                            loader: "js",
                            target: "node18"
                        }
                    }
                }
            ]
        },

        optimization: {
            minimize: isProduction,
            minimizer: [
                new EsbuildPlugin({
                    target: "node18"
                })
            ],
            // Enforce single-file output by disabling chunk splitting
            splitChunks: false,
            runtimeChunk: false
        },

        performance: {
            hints: false
        }
    };

    return config;
};