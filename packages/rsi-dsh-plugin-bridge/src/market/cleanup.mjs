/** Release a candidate without replacing evidence of the operation's failure. */
export async function withCleanup(operation,cleanup) {
  let failed=false,primary;
  try {return await operation();}
  catch(error) {failed=true;primary=error;throw error;}
  finally {
    try {await cleanup();}
    catch(error) {
      if(failed)throw new AggregateError([primary,error],
        String(primary?.message??primary)+'; candidate cleanup failed: '+String(error?.message??error));
      throw error;
    }
  }
}
