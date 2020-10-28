import { ConstructedQuery } from '@sap/cds/apis/ql'
import liquibase from '../liquibase'
import fs from 'fs'
import { Logger } from 'winston'
import { configOptions, liquibaseOptions } from './../config'
import { ChangeLog } from '../ChangeLog'
import { sortByCasadingViews } from '../util'

interface DeployOptions {
  dryRun?: boolean
  loadMode?: string
  autoUndeploy?: boolean
}

/**
 * Base class that contains all the shared stuff.
 */
export abstract class BaseAdapter {
  serviceKey: string
  options: configOptions
  logger: globalThis.Console
  cdsSQL: string[]
  cdsModel: unknown

  /**
   * The constructor
   *
   * @param serviceKey
   * @param options
   */
  constructor(serviceKey: string, options: configOptions) {
    this.serviceKey = serviceKey
    this.options = options
    this.logger = global.console
  }

  /**
   * Fully deploy the cds data model to the reference database.
   * The reference database needs to the cleared first.
   *
   * @abstract
   */
  abstract async _deployCdsToReferenceDatabase(): Promise<void>

  /**
   * Synchronize the clone schema with the default one.
   *
   * @abstract
   */
  abstract async _synchronizeCloneDatabase(): Promise<void>

  /**
   * Drop the views from the clone, since updating views is hard.
   *
   * @abstract
   */
  abstract async _dropViewsFromCloneDatabase(): Promise<void>

  /**
   * Return the specific options for liquibase.
   *
   * @abstract
   */
  abstract liquibaseOptionsFor(cmd: string): liquibaseOptions

  /**
   * Drop tables and views from the database. If +dropAll+ is
   * true, then the whole schema is dropped including non CDS
   * tables/views.
   *
   * @param {boolean} dropAll
   */
  public async drop({ dropAll = false }) {
    if (dropAll) {
      let liquibaseOptions = this.liquibaseOptionsFor('dropAll')
      await liquibase(liquibaseOptions).run('dropAll')
    } else {
      await this._dropCdsEntitiesFromDatabase(this.serviceKey, false)
    }
  }

  /**
   * TODO: Implement
   */
  public async load() {
    // await _load_from_js(db, model)
    // await _init_from_csv(db, model)
    // await _init_from_json(db, model)
  }

  /**
   * Creates a liquibase diff file containing differences between the default
   * and the reference schema.
   *
   * @param {string} outputFile
   */
  public async diff(outputFile = 'diff.txt') {
    // set the stage
    await this.initCds()
    await this._deployCdsToReferenceDatabase()

    // run update to create internal liquibase tables
    let liquibaseOptions = this.liquibaseOptionsFor('update')
    liquibaseOptions.defaultSchemaName = this.options.migrations.schema.reference

    // Revisit: Possible liquibase bug to not support changelogs by absolute path?
    //liquibaseOptions.changeLogFile = `${__dirname}../../template/emptyChangelog.json`
    const tmpChangelogPath = 'tmp/emptyChangelog.json'
    fs.copyFileSync(`${__dirname}/../../template/emptyChangelog.json`, tmpChangelogPath)
    liquibaseOptions.changeLogFile = tmpChangelogPath
    await liquibase(liquibaseOptions).run('update')
    fs.unlinkSync(tmpChangelogPath)

    // create the diff
    liquibaseOptions = this.liquibaseOptionsFor('diff')
    liquibaseOptions.outputFile = outputFile
    await liquibase(liquibaseOptions).run('diff')

    this.logger.log(`[cds-dbm] - diff file generated at ${liquibaseOptions.outputFile}`)
  }

  /**
   * Initialize the cds model (only once)
   */
  private async initCds() {
    this.cdsModel = await cds.load(this.options.service.model)
    this.cdsSQL = (cds.compile.to.sql(this.cdsModel) as unknown) as string[]
    this.cdsSQL.sort(sortByCasadingViews)
  }

  /**
   * Identifies the changes between the cds definition and the database, generates a delta and deploys
   * this to the database.
   * We use a clone and reference schema to identify the delta, because we need to initially drop
   * all the views and we do not want to do this with a potential production database.
   *
   */
  public async deploy({ autoUndeploy = false, loadMode = null, dryRun = false }: DeployOptions) {
    await this.initCds()

    this.logger.log(`[cds-dbm] - starting delta database deployment of service ${this.serviceKey}`)

    const temporaryChangelogFile = `${this.options.migrations.deploy.tmpFile}`
    if (fs.existsSync(temporaryChangelogFile)) {
      fs.unlinkSync(temporaryChangelogFile)
    }

    // Setup the clone
    await this._synchronizeCloneDatabase()

    // Drop the known views from the clone
    await this._dropViewsFromCloneDatabase()

    // Create the initial changelog
    let liquibaseOptions = this.liquibaseOptionsFor('diffChangeLog')
    liquibaseOptions.defaultSchemaName = this.options.migrations.schema.default
    liquibaseOptions.referenceDefaultSchemaName = this.options.migrations.schema.clone
    liquibaseOptions.changeLogFile = temporaryChangelogFile

    await liquibase(liquibaseOptions).run('diffChangeLog')
    const dropViewsChangeLog = ChangeLog.fromFile(temporaryChangelogFile)
    fs.unlinkSync(temporaryChangelogFile)

    // Deploy the current state to the reference database
    await this._deployCdsToReferenceDatabase()

    // Update the changelog with the real changes and added views
    liquibaseOptions = this.liquibaseOptionsFor('diffChangeLog')
    liquibaseOptions.defaultSchemaName = this.options.migrations.schema.clone
    liquibaseOptions.changeLogFile = temporaryChangelogFile

    await liquibase(liquibaseOptions).run('diffChangeLog')

    const diffChangeLog = ChangeLog.fromFile(temporaryChangelogFile)

    // Merge the changelogs
    diffChangeLog.data.databaseChangeLog = dropViewsChangeLog.data.databaseChangeLog.concat(
      diffChangeLog.data.databaseChangeLog
    )

    // Process the changelog
    if (!autoUndeploy) {
      diffChangeLog.removeDropTableStatements()
    }
    diffChangeLog.removeAutoUndeployEntities(this.options.migrations.deploy.undeployFile)
    diffChangeLog.reorderChangelog()
    diffChangeLog.toFile(temporaryChangelogFile)

    // Either log the update sql or deploy it to the database
    const updateCmd = dryRun ? 'updateSQL' : 'update'
    liquibaseOptions = this.liquibaseOptionsFor(updateCmd)
    liquibaseOptions.changeLogFile = temporaryChangelogFile

    const updateSQL: any = await liquibase(liquibaseOptions).run(updateCmd)
    if (!dryRun) {
      this.logger.log(`[cds-dbm] - delta successfully deployed to the database`)
    } else {
      this.logger.log(updateSQL.stdOut)
    }

    fs.unlinkSync(temporaryChangelogFile)
  }

  /**
   * Drops all known views (and tables) from the database.
   *
   * @param {string} service
   */
  protected async _dropCdsEntitiesFromDatabase(service: string, viewsOnly: boolean = true) {
    const model = await cds.load(this.options.service.model)
    const cdssql = cds.compile.to.sql(model)
    const dropViews = []
    const dropTables = []

    for (let each of cdssql) {
      const [, table, entity] = each.match(/^\s*CREATE (?:(TABLE)|VIEW)\s+"?([^\s(]+)"?/im) || []
      if (!table) {
        dropViews.push({ DROP: { view: entity } })
      }
      if (!viewsOnly && table) {
        dropTables.push({ DROP: { table: entity } })
      }
    }

    const tx = cds.services[service].transaction({})
    await tx.run((dropViews as unknown) as ConstructedQuery)
    await tx.run((dropTables as unknown) as ConstructedQuery)
    return tx.commit()
  }
}
