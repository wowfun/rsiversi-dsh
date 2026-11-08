/** Location-free identity shared by the native reader and the original uploader. */
function digest(attachment) {
  if (!attachment.attachmentId.startsWith('sha256:')) throw Error('Expected a sha256 attachment reference');
  return attachment.attachmentId.slice(7);
}
export const nativeFile = attachment => ({id:digest(attachment),name:attachment.name,bytes:attachment.bytes});
export const dshFile = file => ({attachmentId:'sha256:'+file.id,name:file.name,bytes:file.bytes});

export function nativeMedia(attachment) {
  const {mediaType:mime,bytes,width,height}=attachment;
  return {id:digest(attachment),mime,bytes,width,height};
}

export function dshImage({media,presentation}) {
  return {attachmentId:'sha256:'+media.id,mediaType:media.mime,bytes:media.bytes,width:media.width,height:media.height,
    ...(presentation?.name===undefined?{}:{name:presentation.name}),
    ...(presentation?.original_dimensions===undefined?{}:{originalDimensions:{...presentation.original_dimensions}})};
}

export const submissionContent = content => content.map(part=>nativePart(part,'kind'));
export const messageContent = content => content.map(messagePart);
export const messagePart = part => nativePart(part,'type');

function nativePart(part, tag) {
    if(part.type==='text')return {[tag]:'text',text:part.text};
    if(part.type==='file')return {[tag]:'file',file:nativeFile(part.attachment)};
    if(part.type==='image'){
      const {name,originalDimensions}=part.attachment;
      return {[tag]:'image',media:nativeMedia(part.attachment),
        ...(name===undefined&&originalDimensions===undefined?{}:{presentation:{
          ...(name===undefined?{}:{name}),...(originalDimensions===undefined?{}:{original_dimensions:originalDimensions})}})};
    }
    throw Error(`Unsupported native input block: ${part.type}`);
}
