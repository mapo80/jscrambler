/* eslint-disable no-console */
import 'babel-polyfill';

import glob from 'glob';
import path from 'path';
import request from 'axios';
import defaults from 'lodash.defaults';
import fs from 'fs';

import config from './config';
import generateSignedParams from './generate-signed-params';
import JscramblerClient from './client';
import * as mutations from './mutations';
import * as queries from './queries';
import {zip, zipSources, unzip, outputFileSync} from './zip';
import * as introspection from './introspection';

import getProtectionDefaultFragments from './get-protection-default-fragments';

const {intoObjectType} = introspection;

const debug = !!process.env.DEBUG;
const APP_URL = 'https://app.jscrambler.com';

function errorHandler(res) {
  if (res.errors && res.errors.length) {
    res.errors.forEach(error => {
      throw new Error(`Error: ${error.message}`);
    });
  }

  if (res.data && res.data.errors) {
    res.data.errors.forEach(e => console.error(e.message));
    throw new Error('GraphQL Query Error');
  }

  if (res.message) {
    throw new Error(`Error: ${res.message}`);
  }

  return res;
}

function printSourcesErrors(errors) {
  console.error('Application sources errors:');
  console.error(JSON.stringify(errors, null, 2));
  console.error('');
}


function normalizeParameters(parameters) {
  let result;

  if (!Array.isArray(parameters)) {
    result = [];
    Object.keys(parameters).forEach(name => {
      result.push({
        name,
        options: parameters[name]
      });
    });
  } else {
    result = parameters;
  }

  return result;
}

function buildFinalConfig(configPathOrObject) {
  const _config =
    typeof configPathOrObject === 'string'
      ? require(configPathOrObject)
      : configPathOrObject;

  return defaults(_config, config);
}

export default {
  Client: JscramblerClient,
  config,
  generateSignedParams,
  /**
   * Remove and Add application sources
   * @param {object} client
   * @param {string} applicationId
   * @param {{
   *  sources: Array.<{filename: string, content: string}>,
   *  filesSrc: Array.<string>,
   *  cwd: string,
   *  appProfiling: ?object
   * }} opts
   * @returns {Promise<{extension: string, filename: string, content: *}>}
   */
  async updateApplicationSources(
    client,
    applicationId,
    {sources, filesSrc, cwd, appProfiling}
  ) {
    if (sources || (filesSrc && filesSrc.length)) {
      // prevent removing sources if profiling state is READY
      if (appProfiling && appProfiling.data.state === 'READY') {
        throw new Error(
          'Ready profiling data PREVENTS source files from being UPDATED! Please add option *--remove-profiling-data* or *--skip-source* to continue.'
        );
      }

      const removeSourceRes = await this.removeSourceFromApplication(
        client,
        '',
        applicationId
      );

      errorHandler(removeSourceRes);
    }

    let zipped;
    let source;

    if (filesSrc && filesSrc.length) {
      let _filesSrc = [];
      for (let i = 0, l = filesSrc.length; i < l; i += 1) {
        if (typeof filesSrc[i] === 'string') {
          // TODO Replace `glob.sync` with async version
          _filesSrc = _filesSrc.concat(
            glob.sync(filesSrc[i], {
              dot: true
            })
          );
        } else {
          _filesSrc.push(filesSrc[i]);
        }
      }

      if (debug) {
        console.log('Creating zip from source files');
      }

      zipped = await zip(_filesSrc, cwd);
    } else if (sources) {
      if (debug) {
        console.log('Creating zip from sources');
      }

      zipped = await zipSources(sources);
    }

    if (zipped) {
      const content = zipped
        .generate({
          type: 'nodebuffer'
        })
        .toString('base64');

      if (debug) {
        console.log('Adding sources to application');
      }

      source = {
        content,
        filename: 'application.zip',
        extension: 'zip'
      };

      errorHandler(
        await this.addApplicationSource(client, applicationId, source)
      );
    }

    return source;
  },
  // This method is a shortcut method that accepts an object with everything needed
  // for the entire process of requesting an application protection and downloading
  // that same protection when the same ends.
  //
  // `configPathOrObject` can be a path to a JSON or directly an object containing
  // the following structure:
  //
  // ```json
  // {
  //   "keys": {
  //     "accessKey": "",
  //     "secretKey": ""
  //   },
  //   "applicationId": "",
  //   "filesDest": ""
  // }
  // ```
  //
  // Also the following optional parameters are accepted:
  //
  // ```json
  // {
  //   "filesSrc": [""],
  //   "params": {},
  //   "cwd": "",
  //   "host": "api.jscrambler.com",
  //   "port": "443"
  // }
  // ```
  //
  // `filesSrc` supports glob patterns, and if it's provided it will replace the
  // entire application sources.
  //
  // `params` if provided will replace all the application transformation parameters.
  //
  // `cwd` allows you to set the current working directory to resolve problems with
  // relative paths with your `filesSrc` is outside the current working directory.
  //
  // Finally, `host` and `port` can be overridden if you to engage with a different
  // endpoint than the default one, useful if you're running an enterprise version of
  // Jscrambler or if you're provided access to beta features of our product.
  //
  async protectAndDownload(configPathOrObject, destCallback) {
    const finalConfig = buildFinalConfig(configPathOrObject);

    const {
      applicationId,
      host,
      port,
      protocol,
      cafile,
      keys,
      sources,
      stream = true,
      cwd,
      params,
      applicationTypes,
      languageSpecifications,
      sourceMaps,
      randomizationSeed,
      areSubscribersOrdered,
      useRecommendedOrder,
      bail = true,
      jscramblerVersion,
      debugMode,
      proxy,
      clientId,
      tolerateMinification,
      codeHardeningThreshold,
      useProfilingData,
      browsers,
      useAppClassification,
      profilingDataMode,
      removeProfilingData,
      skipSources,
      inputSymbolTable
    } = finalConfig;

    const {accessKey, secretKey} = keys;

    const client = new this.Client({
      accessKey,
      secretKey,
      host,
      port,
      protocol,
      cafile,
      jscramblerVersion,
      proxy,
      clientId
    });

    let filesSrc = finalConfig.filesSrc;
    let filesDest = finalConfig.filesDest;

    if (sources) {
      filesSrc = undefined;
    }

    if (destCallback) {
      filesDest = undefined;
    }

    if (!applicationId) {
      throw new Error('Required *applicationId* not provided');
    }

    if (!filesDest && !destCallback) {
      throw new Error('Required *filesDest* not provided');
    }

    let source;
    if (!skipSources) {
      const appProfiling = await this.getApplicationProfiling(
        client,
        applicationId
      ).catch(e => {
        if (e.statusCode !== 404) throw e;
      });

      if (appProfiling && removeProfilingData) {
        await this.deleteProfiling(client, appProfiling.data.id);
        appProfiling.data.state = 'DELETED';
      }

      source = await this.updateApplicationSources(client, applicationId, {
        sources,
        filesSrc,
        cwd,
        appProfiling
      });
    } else {
      console.log('Update source files SKIPPED');
    }

    const updateData = {
      _id: applicationId,
      debugMode: !!debugMode,
      tolerateMinification,
      codeHardeningThreshold
    };

    if (params && Object.keys(params).length) {
      updateData.parameters = normalizeParameters(params);
      updateData.areSubscribersOrdered = Array.isArray(params);
    }

    if (typeof areSubscribersOrdered !== 'undefined') {
      updateData.areSubscribersOrdered = areSubscribersOrdered;
    }

    if (applicationTypes) {
      updateData.applicationTypes = applicationTypes;
    }

    if (typeof useRecommendedOrder !== 'undefined') {
      updateData.useRecommendedOrder = useRecommendedOrder;
    }

    if (languageSpecifications) {
      updateData.languageSpecifications = languageSpecifications;
    }

    if (typeof sourceMaps !== 'undefined') {
      updateData.sourceMaps = sourceMaps;
    }

    if (useProfilingData !== undefined) {
      updateData.useProfilingData = useProfilingData;
    }
    if (profilingDataMode !== undefined) {
      updateData.profilingDataMode = profilingDataMode;
    }
    if (useAppClassification !== undefined) {
      updateData.useAppClassification = useAppClassification;
    }

    if (browsers) {
      updateData.browsers = browsers;
    }

    if (
      updateData.parameters ||
      updateData.applicationTypes ||
      updateData.languageSpecifications ||
      updateData.browsers ||
      typeof updateData.areSubscribersOrdered !== 'undefined'
    ) {
      if (debug) {
        console.log('Updating parameters of protection');
      }

      const applicationUpdate = await intoObjectType(
        client,
        updateData,
        'Application'
      );
      const updateApplicationRes = await this.updateApplication(
        client,
        applicationUpdate
      );
      if (debug) {
        console.log('Finished updating parameters of protection');
        console.error(updateApplicationRes);
      }
      errorHandler(updateApplicationRes);
    }

    if (debug) {
      console.log('Creating Application Protection');
    }

    delete updateData._id;
    const protectionOptions = {bail, randomizationSeed, tolerateMinification, source, inputSymbolTable, ...updateData};

    if (finalConfig.inputSymbolTable) {
      // Note: we can not use the fs.promises API because some users may not have node 10.
      // Once node 10 is old enough to be safe to assume that all users will have it, this
      // should be safe to replace with `await fs.promises.readFile`.
      const inputSymbolTableContents = fs.readFileSync(finalConfig.inputSymbolTable, 'utf-8');
      protectionOptions.inputSymbolTable = inputSymbolTableContents;
    }

    const createApplicationProtectionRes = await this.createApplicationProtection(
      client,
      applicationId,
      protectionOptions
    );
    errorHandler(createApplicationProtectionRes);

    const protectionId =
      createApplicationProtectionRes.data.createApplicationProtection._id;
    const protection = await this.pollProtection(
      client,
      applicationId,
      protectionId,
      await getProtectionDefaultFragments(client)
    );
    if (protection.growthWarning) {
      console.warn(`Warning: Your protected application has surpassed a reasonable file growth.\nFor more information on what might have caused this, please see the Protection Report.\nLink: ${APP_URL}.`);
    }
    if (debug) {
      console.log('Finished protecting');
    }

    if (protection.deprecations) {
      protection.deprecations.forEach(deprecation => {
        if (deprecation.type === 'Transformation') {
          console.warn(
            `Warning: ${deprecation.type} ${deprecation.entity} is no longer maintained. Please consider removing it from your configuration.`
          );
        } else if (deprecation.type && deprecation.entity) {
          console.warn(
            `Warning: ${deprecation.type} ${deprecation.entity} is deprecated.`
          );
        }
      });
    }

    const sourcesErrors = [];

    protection.sources.forEach(s => {
      if (s.errorMessages && s.errorMessages.length > 0) {
        sourcesErrors.push(
          ...s.errorMessages.map(e => ({
            filename: s.filename,
            ...e
          }))
        );
      }
    });

    if (protection.state === 'errored') {
      console.error('Global protection errors:');
      console.error(`- ${protection.errorMessage}`);
      console.error('');
      if (sourcesErrors.length > 0) {
        printSourcesErrors(sourcesErrors);
      }
      throw new Error(`Protection failed. For more information visit: ${APP_URL}.`);
    } else if (sourcesErrors.length > 0) {
      if (protection.bail) {
        printSourcesErrors(sourcesErrors);
        throw new Error('Your protection has failed.');
      } else {
        sourcesErrors.forEach(e =>
          console.warn(`Non-fatal error: "${e.message}" in ${e.filename}`)
        );
      }
    }

    if (debug) {
      console.log('Downloading protection result');
    }
    const download = await this.downloadApplicationProtection(
      client,
      protectionId
    );

    errorHandler(download);

    if (debug) {
      console.log('Unzipping files');
    }

    unzip(download, filesDest || destCallback, stream);

    if (debug) {
      console.log('Finished unzipping files');
    }

    console.log(protectionId);

    return protectionId;
  },
  /**
   * Instrument and download application sources for profiling purposes
   * @param {object} configPathOrObject
   * @param {function} [destCallback]
   * @returns {Promise<string>}
   */
  async instrumentAndDownload(configPathOrObject, destCallback) {
    const finalConfig = buildFinalConfig(configPathOrObject);

    const {
      applicationId,
      host,
      port,
      protocol,
      cafile,
      keys,
      sources,
      stream = true,
      cwd,
      jscramblerVersion,
      proxy,
      skipSources,
      clientId
    } = finalConfig;

    const {accessKey, secretKey} = keys;

    const client = new this.Client({
      accessKey,
      secretKey,
      host,
      port,
      protocol,
      cafile,
      jscramblerVersion,
      proxy,
      clientId
    });

    let {filesSrc, filesDest} = finalConfig;

    if (sources) {
      filesSrc = undefined;
    }

    if (destCallback) {
      filesDest = undefined;
    }

    if (!applicationId) {
      throw new Error('Required *applicationId* not provided');
    }

    if (!filesDest && !destCallback) {
      throw new Error('Required *filesDest* not provided');
    }

    if (!skipSources) {
      await this.updateApplicationSources(client, applicationId, {
        sources,
        filesSrc,
        cwd
      });
    } else {
      console.log('Update source files SKIPPED');
    }

    let instrumentation = await this.startInstrumentation(
      client,
      applicationId
    );
    errorHandler(instrumentation);

    instrumentation = await this.pollInstrumentation(
      client,
      instrumentation.data.id
    );
    if (debug) {
      console.log(
        `Finished instrumention with id ${instrumentation.data.id}. Downloading...`
      );
    }

    const download = await this.downloadApplicationInstrumented(
      client,
      instrumentation.data.id
    );
    errorHandler(download);

    if (debug) {
      console.log('Unzipping files');
    }

    unzip(download, filesDest || destCallback, stream);

    if (debug) {
      console.log('Finished unzipping files');
    }

    console.warn(`
      WARNING: DO NOT SEND THIS CODE TO PRODUCTION AS IT IS NOT PROTECTED
    `);

    console.log(
      `Application ${applicationId} was instrumented. Bootstrap your application, go to ${APP_URL} and start profiling!`
    );


    return instrumentation.data.id;
  },

  /**
   * Change the profiling run stat.
   * @param configPathOrObject
   * @param state
   * @param label
   * @returns {Promise<string>} The previous state
   */
  async setProfilingState(configPathOrObject, state, label) {
    const finalConfig = buildFinalConfig(configPathOrObject);

    const {
      keys,
      host,
      port,
      protocol,
      cafile,
      applicationId,
      proxy,
      jscramblerVersion,
      clientId
    } = finalConfig;

    const {accessKey, secretKey} = keys;

    const client = new this.Client({
      accessKey,
      secretKey,
      host,
      port,
      protocol,
      cafile,
      proxy,
      jscramblerVersion,
      clientId
    });
    const instrumentation = await client
      .get('/profiling-run', {applicationId})
      .catch(e => {
        if (e.statusCode !== 404) throw e;
      });

    if (!instrumentation) {
      throw new Error(
        'There is no active profiling run. Instrument your application first.'
      );
    }

    const previousState = instrumentation.data.state;
    if (previousState === state) {
      console.log(
        `Profiling was already ${label} for application ${applicationId}.`
      );
      return;
    }

    await client.patch(`/profiling-run/${instrumentation.data.id}`, {
      state
    });

    console.log(`Profiling was ${label} for application ${applicationId}.`);
  },

  async downloadSourceMaps(configs, destCallback) {
    const {
      keys,
      host,
      port,
      protocol,
      cafile,
      stream = true,
      filesDest,
      filesSrc,
      protectionId,
      jscramblerVersion,
      proxy
    } = configs;

    const {accessKey, secretKey} = keys;

    const client = new this.Client({
      accessKey,
      secretKey,
      host,
      port,
      protocol,
      cafile,
      jscramblerVersion,
      proxy
    });

    if (!filesDest && !destCallback) {
      throw new Error('Required *filesDest* not provided');
    }

    if (!protectionId) {
      throw new Error('Required *protectionId* not provided');
    }

    if (filesSrc) {
      console.warn(
        '[Warning] Ignoring sources supplied. Downloading source maps of given protection'
      );
    }
    let download;
    try {
      download = await this.downloadSourceMapsRequest(client, protectionId);
    } catch (e) {
      errorHandler(e);
    }
    unzip(download, filesDest || destCallback, stream);
  },
  async downloadSymbolTable(configs, destCallback) {
    const {
      keys,
      host,
      port,
      protocol,
      cafile,
      stream = true,
      filesDest,
      filesSrc,
      protectionId,
      jscramblerVersion,
      proxy
    } = configs;

    const {accessKey, secretKey} = keys;

    const client = new this.Client({
      accessKey,
      secretKey,
      host,
      port,
      protocol,
      cafile,
      jscramblerVersion,
      proxy
    });

    if (!filesDest && !destCallback) {
      throw new Error('Required *filesDest* not provided');
    }

    if (!protectionId) {
      throw new Error('Required *protectionId* not provided');
    }

    if (filesSrc) {
      console.warn(
        '[Warning] Ignoring sources supplied. Downloading symbol table of given protection'
      );
    }
    let download;
    try {
      download = await this.downloadSymbolTableRequest(client, protectionId);
    } catch (e) {
      errorHandler(e);
    }

    if (typeof destCallback === 'function') {
      destCallback(download, filesDest);
    } else {
      outputFileSync(
        path.join(filesDest, `${protectionId}_symbolTable.json`),
        download
      );
    }
  },
  /**
   * Polls a instrumentation every 500ms until the state be equal to
   * FINISHED_INSTRUMENTATION, FAILED_INSTRUMENTATION or DELETED
   * @param {object} client
   * @param {string} instrumentationId
   * @returns {Promise<object>}
   * @throws {Error} due to errors in instrumentation process or user cancel the operation
   */
  async pollInstrumentation(client, instrumentationId) {
    const poll = async () => {
      const instrumentation = await this.getInstrumentation(
        client,
        instrumentationId
      );
      switch (instrumentation.data.state) {
        case 'DELETED':
          throw new Error('Protection canceled by user');
        case 'FAILED_INSTRUMENTATION':
          instrumentation.errors = instrumentation.errors.concat(
            instrumentation.data.instrumentationErrors.map(e => ({
              message: `${e.message} at ${e.fileName}:${e.lineNumber}`
            }))
          );
          return errorHandler(instrumentation);
        case 'FINISHED_INSTRUMENTATION':
          return instrumentation;
        default:
          await new Promise(resolve => setTimeout(resolve, 500));
          return poll();
      }
    };
    return poll();
  },
  async pollProtection(client, applicationId, protectionId, fragments) {
    const poll = async () => {
      const applicationProtection = await this.getApplicationProtection(
        client,
        applicationId,
        protectionId,
        fragments
      );
      if (applicationProtection.errors) {
        console.log('Error polling protection', applicationProtection.errors);

        throw new Error(
          `Protection failed. For more information visit: ${APP_URL}.`
        );
      } else {
        const {state} = applicationProtection.data.applicationProtection;
        if (
          state !== 'finished' &&
          state !== 'errored' &&
          state !== 'canceled'
        ) {
          await new Promise(resolve => setTimeout(resolve, 500));
          return poll();
        } else if (state === 'canceled') {
          throw new Error('Protection canceled by user');
        } else {
          return applicationProtection.data.applicationProtection;
        }
      }
    };

    return poll();
  },
  //
  async createApplication(client, data, fragments) {
    return client.post(
      '/application',
      mutations.createApplication(data, fragments)
    );
  },
  //
  async duplicateApplication(client, data, fragments) {
    return client.post(
      '/application',
      mutations.duplicateApplication(data, fragments)
    );
  },
  //
  async removeApplication(client, id) {
    return client.post('/application', mutations.removeApplication(id));
  },
  //
  async removeProtection(client, id, appId, fragments) {
    return client.post(
      '/application',
      mutations.removeProtection(id, appId, fragments)
    );
  },
  //
  async cancelProtection(client, id, appId, fragments) {
    const mutation = await mutations.cancelProtection(id, appId, fragments);
    return client.post('/application', mutation);
  },
  //
  async updateApplication(client, application, fragments) {
    const mutation = await mutations.updateApplication(application, fragments);
    return client.post('/application', mutation);
  },
  //
  async unlockApplication(client, application, fragments) {
    const mutation = await mutations.unlockApplication(application, fragments);
    return client.post('/application', mutation);
  },
  //
  async getApplication(client, applicationId, fragments, params) {
    const query = await queries.getApplication(
      applicationId,
      fragments,
      params
    );
    return client.get('/application', query);
  },
  //
  async getApplicationSource(client, sourceId, fragments, limits) {
    const query = await queries.getApplicationSource(
      sourceId,
      fragments,
      limits
    );
    return client.get('/application', query);
  },
  //
  async getApplicationProtections(client, applicationId, params, fragments) {
    const query = await queries.getApplicationProtections(
      applicationId,
      params,
      fragments
    );
    return client.get('/application', query);
  },
  //
  async getApplicationProtectionsCount(client, applicationId, fragments) {
    const query = await queries.getApplicationProtectionsCount(
      applicationId,
      fragments
    );
    return client.get('/application', query);
  },
  //
  async createTemplate(client, template, fragments) {
    const mutation = await mutations.createTemplate(template, fragments);
    return client.post('/application', mutation);
  },
  //
  async removeTemplate(client, id) {
    const mutation = await mutations.removeTemplate(id);
    return client.post('/application', mutation);
  },
  //
  async getTemplates(client, fragments) {
    const query = await queries.getTemplates(fragments);
    return client.get('/application', query);
  },
  //
  async getApplications(client, fragments, params) {
    const query = await queries.getApplications(fragments, params);
    return client.get('/application', query);
  },
  //
  async addApplicationSource(
    client,
    applicationId,
    applicationSource,
    fragments
  ) {
    const mutation = await mutations.addApplicationSource(
      applicationId,
      applicationSource,
      fragments
    );
    return client.post('/application', mutation);
  },
  //
  async addApplicationSourceFromURL(client, applicationId, url, fragments) {
    const file = await getFileFromUrl(client, url);
    const mutation = await mutations.addApplicationSource(
      applicationId,
      file,
      fragments
    );

    return client.post('/application', mutation);
  },
  //
  async updateApplicationSource(client, applicationSource, fragments) {
    const mutation = await mutations.updateApplicationSource(
      applicationSource,
      fragments
    );
    return client.post('/application', mutation);
  },
  //
  async removeSourceFromApplication(
    client,
    sourceId,
    applicationId,
    fragments
  ) {
    const mutation = await mutations.removeSourceFromApplication(
      sourceId,
      applicationId,
      fragments
    );
    return client.post('/application', mutation);
  },
  //
  async applyTemplate(client, templateId, appId, fragments) {
    const mutation = await mutations.applyTemplate(
      templateId,
      appId,
      fragments
    );
    return client.post('/application', mutation);
  },
  //
  async updateTemplate(client, template, fragments) {
    const mutation = await mutations.updateTemplate(template, fragments);
    return client.post('/application', mutation);
  },
  async getApplicationProfiling(client, applicationId) {
    return client.get('/profiling-run', {applicationId});
  },
  async deleteProfiling(client, profilingId) {
    return client.patch(`/profiling-run/${profilingId}`, {
      state: 'DELETED'
    });
  },
  /**
   * Starts a new instrumentation process.
   * Previous instrumentation must be deleted, before starting a new one.
   * @param client
   * @param applicationId
   * @returns {Promise<*>}
   */
  async startInstrumentation(client, applicationId) {
    const instrumentation = await this.getApplicationProfiling(
      client,
      applicationId
    ).catch(e => {
      if (e.statusCode !== 404) throw e;
    });

    if (instrumentation) {
      await this.deleteProfiling(client, instrumentation.data.id);
    }
    return client.post('/profiling-run', {applicationId});
  },
  //
  async createApplicationProtection(
    client,
    applicationId,
    protectionOptions,
    fragments
  ) {
    const {args} = await introspection.mutation(
      client,
      'createApplicationProtection'
    );

    const mutation = await mutations.createApplicationProtection(
      applicationId,
      fragments,
      protectionOptions,
      args
    );

    return client.post('/application', mutation);
  },
  /**
   * @param {object} client
   * @param {string} instrumentationId
   * @returns {Promise<object>}
   */
  async getInstrumentation(client, instrumentationId) {
    return client.get(`/profiling-run/${instrumentationId}`);
  },
  //
  async getApplicationProtection(
    client,
    applicationId,
    protectionId,
    fragments
  ) {
    const query = await queries.getProtection(
      applicationId,
      protectionId,
      fragments
    );
    return client.get('/application', query);
  },
  //
  async downloadSourceMapsRequest(client, protectionId) {
    return client.get(`/application/sourceMaps/${protectionId}`, null, false);
  },
  async downloadSymbolTableRequest(client, protectionId) {
    return client.get(`/application/symbolTable/${protectionId}`, null, false);
  },
  //
  async downloadApplicationProtection(client, protectionId) {
    return client.get(`/application/download/${protectionId}`, null, false);
  },
  /**
   * @param {object} client
   * @param {string} instrumentationId
   * @returns {*}
   */
  downloadApplicationInstrumented(client, instrumentationId) {
    return client.get(
      `/profiling-run/${instrumentationId}/instrumented-bundle`,
      null,
      false
    );
  }
};

function getFileFromUrl(client, url) {
  return request.get(url).then(res => ({
    content: res.data,
    filename: path.basename(url),
    extension: path.extname(url).substr(1)
  }));
}
