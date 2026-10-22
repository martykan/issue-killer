// @hutch cli=0.28.1 cottontail=0.7.2
// Hutch drives the Electrobun desktop build (see README → Desktop app). App code itself uses Bun + bun install.
export default {
	scripts: {
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
	},
	electrobun: {
		version: "2.0.4",
	},
};
