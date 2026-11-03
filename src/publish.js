import { composeManually, isCreditError } from './compose.js';
import { describeXError, createXClient, postTweet } from './x.js';
import { UserError } from './util.js';

export const POST_MODES = ['auto', 'composer'];

const NOOP_LOGGER = {
  info: () => {},
  step: () => {},
  success: () => {},
  warn: () => {},
  detail: () => {},
  error: () => {},
  blank: () => {},
};

function hasXCredentials(config) {
  return Boolean(
    config.x?.apiKey && config.x?.apiSecret && config.x?.accessToken && config.x?.accessSecret,
  );
}

/**
 * Publish with the official X API, or prepare X's supported Web Intent for a
 * person to review and submit. The composer path never automates the website.
 */
export async function publishText({
  text,
  mode = 'auto',
  config,
  logger = NOOP_LOGGER,
  imagePath = null,
  save,
  compose = composeManually,
  post = postTweet,
  createClient = createXClient,
  client,
}) {
  const value = String(text ?? '').trim();
  if (!value) throw new UserError('Refusing to publish an empty draft.');

  if (!POST_MODES.includes(mode)) {
    throw new UserError(`Unknown publish mode "${mode}". Use ${POST_MODES.join(', ')}.`);
  }

  const openComposer = async (reason) => {
    const result = await compose({
      text: value,
      imagePath,
      logger,
      save,
      settings: config.xpost,
    });
    return {
      status: 'composer',
      mode: 'composer',
      url: result.url,
      tweetId: null,
      file: result.file ?? null,
      needsClick: true,
      message: 'X composer prepared — review the text and press Post there.',
      reason,
    };
  };

  if (mode === 'composer') return openComposer('requested');
  if (!hasXCredentials(config) || config.xpost?.manual) {
    return openComposer(config.xpost?.manual ? 'manual mode' : 'no X credentials');
  }

  let apiClient = client;
  if (!apiClient) {
    try {
      apiClient = createClient(config);
    } catch (error) {
      return openComposer(`X client unavailable: ${error.message}`);
    }
  }

  try {
    const tweet = await post({ client: apiClient, text: value, imagePath });
    return {
      status: 'posted',
      mode: 'api',
      url: tweet.url,
      tweetId: tweet.id ?? null,
      message: `Posted: ${tweet.url}`,
    };
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (isCreditError(error)) {
      logger.warn(describeXError(error));
      logger.detail('Opening the X composer instead. Review and submit the post there.');
      return openComposer('out of API credits');
    }
    throw new UserError(describeXError(error));
  }
}
