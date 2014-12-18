var fs = require('fs');
var async = require('async');
var _ = require('lodash');
var request = require('request');
var doT = require('dot');

startup(function (err, result) {
	if (err) {
		console.error(err);
		process.exit(1);
	}

	getNpmPlugins(function (err, plugins) {
		async.eachSeries(plugins, getPluginInfo, function (err) {
			if (err) {
				console.error(err);
				process.exit(1);
			}
			writePluginList(_.extend(result, {plugins: plugins}), function (err) {
				if (err) {
					console.error(err);
					process.exit(1);
				}
				console.log('Done');
				process.exit(0);
			});
		});
	});
});

function startup(cb) {
	var outputFile = '../README.md';
	doT.templateSettings.strip = false; // keep whitespace, markdown needs it

	async.parallel({
		headerFn: _.partial(fs.readFile, './templates/header.dot', {encoding: 'utf8'}),
		rowFn: _.partial(fs.readFile, './templates/pluginRow.dot', {encoding: 'utf8'}),
		categoryHeaderFn: _.partial(fs.readFile, './templates/categoryHeader.dot', {encoding: 'utf8'}),
		coreRefRowFn: _.partial(fs.readFile, './templates/coreRefPluginRow.dot', {encoding: 'utf8'}),
		clean: function (pCb) {
			fs.exists(outputFile, function (exists) {
				if (!exists) return pCb();
				fs.unlink(outputFile, pCb);
			});
		}
	}, function (err, results) {
		if (err) return cb(err);
		return cb(null, {
			headerFn: doT.template(results.headerFn),
			rowFn: doT.template(results.rowFn),
			categoryHeaderFn: doT.template(results.categoryHeaderFn),
			coreRefRowFn: doT.template(results.coreRefRowFn),
			outputFile: outputFile
		});
	});
}

function getNpmPlugins(cb) {
	var npmUrl = 'http://nipster.blob.core.windows.net/cdn/npm-datatables.json';

	// sometimes the repo specified in the package.json isn't correct
	var repoFragmentOverrides = {
		'seneca-couchdb-store': 'bamse16/seneca-couchdb-store',
		'seneca-couchdb-changes': 'AdrianRossouw/seneca-couchdb-changes',
		'seneca-dynamo-store': 'darsee/seneca-dynamo-store',
		'seneca-linkedin-auth': 'davidmarkclements/seneca-linkedin-auth',
		'seneca-mysql-store': 'mirceaalexandru/seneca-mysql-store',
		'seneca-postgresql-store': 'https://github.com/marianr/seneca-postgres-store'
	};

	var ignoredPlugins = [
		'seneca-dynamodb',
		'seneca-mysql',
		'seneca-postgres',
		'seneca-postgres-store',
		'seneca-memcached'
	];

	console.log('Fetching NPM packages');
	request({
		uri: npmUrl,
		json: true,
		gzip: true
	}, function (error, response, body) {
		if (error) return cb(error);

		var plugins = _(body.aaData)
			.filter(function (row) {
				return ~row[0].indexOf('seneca') && !~ignoredPlugins.indexOf(row[0]);
			}).map(function (row) {
				var name = row[0];
				var repoFragment = row[1];
				var description = row[2];
				var displayName = name === 'seneca' ? '(core)' : name.replace(/seneca\-/, '');

				return {
					name: name,
					displayName: displayName,
					repoFragment: repoFragment || repoFragmentOverrides[name],
					description: description,
					categories: setPluginCategories(displayName)
				};
			}).sortBy('displayName')
			.valueOf();

		cb(null, plugins);
	});
}

// a plugin can be in at most 2 categories, when a plugin is in 2 categories
// one of those will be the Core category
function setPluginCategories(displayName) {
	var ret = [];
	if (~[
			'(core)',
			'basic',
			'echo',
			'mem-store',
			'transport',
			'web'
		].indexOf(displayName))
		ret.push('Core');

	if (displayName === '(core)') return ret;

	if (~displayName.indexOf('-store')) {
		ret.push('Stores');
		return ret;
	}

	if (~displayName.indexOf('-cache')) {
		ret.push('Caches');
		return ret;
	}

	if (~displayName.indexOf('-transport') || displayName === 'transport') {
		ret.push('Transports');
		return ret;
	}

	if (~displayName.indexOf('-auth')) {
		ret.push('Auth');
		return ret;
	}

	ret.push('Other');
	return ret;
}

function getPluginInfo(plugin, cb) {
	console.log("Processing: %s", plugin.displayName);

	var info = {
		repository: {type: '', url: ''},
		dependenciesBadge: 'n/a',
		codeClimateBadge: 'n/a',
		repositoryString: 'n/a',
		buildBadge: 'n/a'
	};
	if (!plugin.repoFragment) {
		return setImmediate(function () {
			cb(null, _.extend(plugin, info));
		});
	}

	// see if the Github repo exists
	var repoUrl = 'https://github.com/' + plugin.repoFragment;

	request(repoUrl, function (error, response, body) {
		// repo doesn't exist (ok, Github could be down too, but hey, this is an ad hoc script :)
		if (response.statusCode !== 200) return cb(null, info);

		info.repository = {type: 'git', url: repoUrl};
		info.repositoryString = '[Github](' + info.repository.url + ')';

		var url = 'https://david-dm.org/' + plugin.repoFragment;
		info.dependenciesBadge = '[![Dependency Status](' + url + '.svg)](' + url + ')';

		// parse html from repo's main page to check for build badge (Crazy? Yes, but it's working so far)
		url = 'travis-ci.org/' + plugin.repoFragment;
		info.buildBadge = 'n/a';

		if (~body.indexOf(url)) {
			url = 'https://' + url;
			info.buildBadge = '[![Build Status](' + url + '.svg)](' + url + ')';
		}

		url = 'https://codeclimate.com/github/' + plugin.repoFragment;
		info.codeClimateBadge = '[![Code Climate](' + url + '/badges/gpa.svg)](' + url + ')';

		cb(null, _.extend(plugin, info));
	});
}

function writePluginList(params, cb) {
	var headerFn = params.headerFn;
	var rowFn = params.rowFn;
	var outputFile = params.outputFile;
	var categoryHeaderFn = params.categoryHeaderFn;
	var coreRefRowFn = params.coreRefRowFn;

	var output = headerFn();
	var plugins = params.plugins;

	var orderedCategories = ['Core', 'Auth', 'Caches', 'Stores', 'Transports', 'Other'];

	// this is quite inefficient, but perhaps passable since it's an ad hoc script
	_.each(orderedCategories, function (categoryName) {
		output += categoryHeaderFn({category: categoryName});

		_.each(plugins, function (plugin) {
			if (!~plugin.categories.indexOf(categoryName))
				return;

			if (categoryName === 'Core' || plugin.categories.length === 1) {
				output += rowFn(plugin);
				return;
			}

			// in code category and another as well, the plugin listing in the other category will have a
			// (see core) annotation
			output += coreRefRowFn(plugin);
		});
	});

	fs.writeFile(outputFile, output, cb);
}
