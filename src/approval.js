import { validateTweet } from './tweet.js';
import { UserError, color, wrapText } from './util.js';

export function renderDraft({ text, imagePath, maxChars, out = process.stdout }) {
  const validation = validateTweet(text, maxChars);
  const count = validation.ok ? color.dim(`${validation.length}/${maxChars} characters`) : color.red(`${validation.length}/${maxChars} characters`);

  out.write(`\n${color.dim('─'.repeat(72))}\n`);
  out.write(`${color.bold('DRAFT')}  ${count}\n\n`);
  out.write(
    wrapText(text, 68)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );
  out.write('\n');
  if (imagePath) out.write(`\n  ${color.dim('image:')} ${imagePath}\n`);
  out.write(`${color.dim('─'.repeat(72))}\n`);

  return validation;
}

function ask(rl, query) {
  return new Promise((resolve, reject) => {
    let settled = false;

    // A piped final line arrives just before "close", so give the answer a
    // chance to resolve before treating closed input as a cancellation.
    const onClose = () => {
      setImmediate(() => {
        if (settled) return;
        settled = true;
        reject(
          new UserError('Input ended before a choice was made. Nothing was posted.', {
            exitCode: 2,
          }),
        );
      });
    };

    rl.once('close', onClose);
    try {
      rl.question(query).then(
        (answer) => {
          settled = true;
          rl.off('close', onClose);
          resolve(answer);
        },
        (error) => {
          settled = true;
          rl.off('close', onClose);
          reject(error);
        },
      );
    } catch (error) {
      settled = true;
      rl.off('close', onClose);
      reject(error);
    }
  });
}

/**
 * Show the draft until the user explicitly chooses p (post), s (save),
 * or q (quit). Nothing here can reach X unless `dryRun` is false and the
 * `post` callback is invoked by an explicit "p".
 */
export async function reviewDraft({
  text,
  imagePath = null,
  maxChars = 280,
  dryRun = false,
  manual = false,
  interactive = Boolean(process.stdin.isTTY),
  rl,
  logger,
  out = process.stdout,
  regenerate,
  makeImage,
  editText,
  save,
  post,
}) {
  let currentText = text;
  let currentImage = imagePath;

  for (;;) {
    const validation = renderDraft({ text: currentText, imagePath: currentImage, maxChars, out });
    if (!validation.ok) logger.warn(validation.problems.join(' '));

    if (dryRun) {
      logger.detail('Dry run: choosing p saves the draft and never calls the X API.');
    }

    const imageChoice = makeImage ? `  ${color.bold('[i]')}mage` : '';
    const answer = (
      await ask(
        rl,
        `  ${color.bold('[p]')}ost  ${color.bold('[e]')}dit  ${color.bold('[r]')}egenerate${imageChoice}  ${color.bold('[s]')}ave  ${color.bold('[q]')}uit  › `,
      )
    )
      .trim()
      .toLowerCase();

    // Piped input has no terminal echo, so end the prompt line ourselves.
    if (!interactive) out.write('\n');

    if (!answer) continue;
    const choice = answer[0];

    if (choice === 'q') {
      logger.info('\nNothing posted.');
      return { action: 'quit', text: currentText, imagePath: currentImage };
    }

    if (choice === 'e') {
      try {
        const edited = await editText(currentText);
        if (edited && edited.trim()) {
          currentText = edited.trim();
        } else {
          logger.warn('Empty edit ignored; kept the previous text.');
        }
      } catch (error) {
        logger.error(`Could not edit the draft: ${error.message}`);
      }
      continue;
    }

    if (choice === 'r') {
      try {
        logger.step('Regenerating draft…');
        const next = await regenerate(currentText);
        if (next && next.trim()) {
          currentText = next.trim();
        } else {
          logger.warn('The model returned an empty draft; kept the previous text.');
        }
      } catch (error) {
        logger.error(`Regeneration failed: ${error.message}`);
      }
      continue;
    }

    if (choice === 'i' && makeImage) {
      try {
        logger.step('Generating image…');
        const nextImage = await makeImage(currentText);
        if (nextImage) {
          currentImage = nextImage;
          logger.success(`Image attached: ${nextImage}`);
        }
      } catch (error) {
        logger.error(`Image generation failed: ${error.message}`);
      }
      continue;
    }

    if (choice === 's') {
      const result = await save({
        status: 'saved',
        text: currentText,
        imagePath: currentImage,
      });
      logger.success(`Saved without posting: ${result.file}`);
      return {
        action: 'saved',
        text: currentText,
        imagePath: currentImage,
        file: result.file,
      };
    }

    if (choice === 'p') {
      const check = validateTweet(currentText, maxChars);
      if (!check.ok) {
        logger.warn(`${check.problems.join(' ')} Edit or regenerate before posting.`);
        continue;
      }

      if (dryRun) {
        const result = await save({
          status: 'dry-run',
          text: currentText,
          imagePath: currentImage,
        });
        logger.success(`Dry run complete — nothing was sent to X. Saved: ${result.file}`);
        return {
          action: 'dry-run',
          text: currentText,
          imagePath: currentImage,
          file: result.file,
        };
      }

      if (!interactive && !manual) {
        logger.error(
          'Refusing to post: approval is not running in a terminal. Re-run interactively, or use --dry-run.',
        );
        return {
          action: 'refused',
          text: currentText,
          imagePath: currentImage,
        };
      }

      try {
        const result = await post({ text: currentText, imagePath: currentImage });
        if (result.needsClick) {
          logger.success(
            'X composer prepared — review the text in your browser and press Post to publish.',
          );
          logger.detail(`  ${result.tweet.url}`);
        } else {
          logger.success(`Posted: ${result.tweet.url}`);
        }
        return {
          action: 'posted',
          text: currentText,
          imagePath: currentImage,
          tweet: result.tweet,
          file: result.file,
        };
      } catch (error) {
        logger.error(error.message);
        try {
          await save({
            status: 'failed',
            text: currentText,
            imagePath: currentImage,
            error: error.message,
          });
        } catch (saveError) {
          logger.warn(`Could not save the failed draft: ${saveError.message}`);
        }
        logger.detail('The draft is still open. Fix the problem and press p to retry, or q to quit.');
        continue;
      }
    }

    logger.warn(`Unknown choice "${answer}". Use p, e, r, i, s, or q.`);
  }
}
