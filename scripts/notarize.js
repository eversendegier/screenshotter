const { notarize } = require('@electron/notarize');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`Notariseren: ${appPath}`);
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: 'mail@hiddecollee.nl',
    appleIdPassword: 'ytgz-dqpb-tchk-tofm',
    teamId: 'W2N2RLUR3S',
  });
  console.log('Notariseren klaar.');
};
