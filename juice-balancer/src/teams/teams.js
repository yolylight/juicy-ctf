const express = require('express');
const bcrypt = require('bcryptjs');
const cryptoRandomString = require('crypto-random-string');

const Joi = require('@hapi/joi');
const expressJoiValidation = require('express-joi-validation');
const promClient = require('prom-client');

const validator = expressJoiValidation.createValidator();

const router = express.Router();

const {
  createDeploymentForTeam,
  createServiceForTeam,
  getJuiceShopInstanceForTeamname,
  getJuiceShopInstances,
} = require('../kubernetes');

const loginCounter = new promClient.Counter({
  name: 'multijuicer_logins',
  help: 'Number of logins (including registrations, see label "type").',
  labelNames: ['type', 'userType'],
});
const failedLoginCounter = new promClient.Counter({
  name: 'multijuicer_failed_logins',
  help: 'Number of failed logins, bad password (including admin logins, see label "type").',
  labelNames: ['userType'],
});

const { logger } = require('../logger');
const { get } = require('../config');

const BCRYPT_ROUNDS = process.env['NODE_ENV'] === 'production' ? 12 : 2;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const cookieSettings = {
  signed: true,
  httpOnly: true,
  sameSite: 'strict',
  secure: get('cookieParser.secure'),
};

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function interceptAdminLogin(req, res, next) {
  const { team } = req.params;
  const { passcode } = req.body;

  if (team === get('admin.username') && passcode === get('admin.password')) {
    loginCounter.inc({ type: 'login', userType: 'admin' }, 1);
    return res
      .cookie(get('cookieParser.cookieName'), `t-${team}`, {
        ...cookieSettings,
      })
      .json({
        message: 'Signed in as admin',
      });
  } else if (team === get('admin.username')) {
    failedLoginCounter.inc({ userType: 'admin' }, 1);
    return res.status(401).json({
      message: 'Team requires authentication to join',
    });
  }

  return next();
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function checkIfTeamAlreadyExists(req, res, next) {
  const { team } = req.params;
  const { passcode } = req.body;

  logger.debug(`Checking if team ${team} already has a JuiceShop Deployment`);

  try {
    const { passcodeHash } = await getJuiceShopInstanceForTeamname(team);

    logger.debug(`Team ${team} already has a JuiceShop deployment`);

    if (passcode !== undefined && (await bcrypt.compare(passcode, passcodeHash))) {
      // Set cookie, (join team)
      loginCounter.inc({ type: 'login', userType: 'user' }, 1);
      return res
        .cookie(get('cookieParser.cookieName'), `t-${team}`, {
          ...cookieSettings,
        })
        .status(200)
        .send({
          message: 'Joined Team',
        });
    }

    failedLoginCounter.inc({ userType: 'user' }, 1);

    return res.status(401).json({
      message: 'Team requires authentication to join',
    });
  } catch (error) {
    if (error.message === `deployments.apps "t-${team}-juiceshop" not found`) {
      logger.info(`Team ${team} doesn't have a JuiceShop deployment yet`);
      return next();
    } else {
      logger.error('Encountered unknown error while checking for existing JuiceShop deployment');
      logger.error(error.message);
      return res
        .status(500)
        .send({ message: `Unknown error while looking for an existing instance."` });
    }
  }
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function checkIfMaxJuiceShopInstancesIsReached(req, res, next) {
  const maxInstances = get('maxJuiceShopInstances');

  // If max instances is set to negative numbers it's not capped
  if (maxInstances < 0) {
    logger.debug(`Skipping max instance check, max instances is set to "${maxInstances}"`);
    return next();
  }

  try {
    const response = await getJuiceShopInstances();

    const instances = response.body.items;

    logger.info(`Reached ${instances.length}/${maxInstances} instances`);
    if (instances.length >= maxInstances) {
      logger.error('Max instance count reached');
      return res.status(500).send({
        message: 'Reached Maximum Instance Count',
        description: ' Find a Admin to handle this.',
      });
    }
    next();
  } catch (error) {
    logger.error('Failed to check max instances');
    logger.error(error.message);
    next();
  }
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
async function createTeam(req, res) {
  const { team } = req.params;
  try {
    const passcode = cryptoRandomString({ length: 8 }).toUpperCase();
    const hash = await bcrypt.hash(passcode, BCRYPT_ROUNDS);

    logger.info(`Creating JuiceShop Deployment for team "${team}"`);

    await createDeploymentForTeam({ team, passcodeHash: hash });
    await createServiceForTeam(team);

    logger.info(`Created JuiceShop Deployment for team "${team}"`);

    loginCounter.inc({ type: 'registration', userType: 'user' }, 1);

    res
      .cookie(get('cookieParser.cookieName'), `t-${team}`, {
        ...cookieSettings,
      })
      .status(200)
      .json({
        message: 'Created Instance',
        passcode,
      });
  } catch (error) {
    logger.error(`Error while creating deployment or service for team ${team}`);
    logger.error(error.message);
    res.status(500).send({ message: 'Failed to Create Instance' });
  }
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
async function awaitReadiness(req, res) {
  const { team } = req.params;

  logger.info(`Awaiting readiness of JuiceShop Deployment for team "${team}"`);

  try {
    for (let i = 0; i < 180; i++) {
      const { readyReplicas } = await getJuiceShopInstanceForTeamname(team);

      if (readyReplicas === 1) {
        logger.info(`JuiceShop Deployment for team "${team}" ready`);

        return res.status(200).send();
      }

      await sleep(1000);
    }

    logger.error(`Waiting for deployment of team "${team}" timed out`);
    res.status(500).send({ message: 'Waiting for Deployment Readiness Timed Out' });
  } catch (error) {
    logger.error(`Failed to wait for teams "${team}" deployment to get ready`);
    logger.error(error);
    res.status(500).send({ message: 'Failed to Wait For Deployment Readiness' });
  }
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
function logout(req, res) {
  return res
    .cookie(get('cookieParser.cookieName'), {
      expires: new Date(0),
      ...cookieSettings,
    })
    .send();
}

const paramsSchema = Joi.object({
  team: Joi.string()
    .required()
    .max(16)
    .regex(/^[a-z0-9]([-a-z0-9])+[a-z0-9]$/),
});
const bodySchema = Joi.object({
  passcode: Joi.string()
    .alphanum()
    .uppercase()
    .length(8),
});

router.post('/logout', logout);

router.post(
  '/:team/join',
  validator.params(paramsSchema),
  validator.body(bodySchema),
  interceptAdminLogin,
  checkIfTeamAlreadyExists,
  checkIfMaxJuiceShopInstancesIsReached,
  createTeam
);

router.get('/:team/wait-till-ready', validator.params(paramsSchema), awaitReadiness);

module.exports = router;
